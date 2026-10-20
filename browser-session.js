import { getLightPandaServer, stopLightPandaServer } from './lightpanda-server.js';
import browserPool, { buildLaunchArgs } from './browser-pool.js';
import { redactUrl, SENSITIVE_FIELD_RE } from './redact.js';

const FALLBACK_REASONS = {
  SCREENSHOT: 'screenshot_requested',
  CDP_ERROR: 'cdp_protocol_error',
  BOT_DETECTION: 'bot_detection',
  NAVIGATION_FAILED: 'navigation_after_click_failed',
  METHOD_NOT_SUPPORTED: 'method_not_supported',
};

/**
 * SAFE actions may be transparently retried on another engine after a
 * failure; MUTATING actions are never replayed once dispatched — an error
 * after dispatch yields { outcome: 'uncertain' } and the caller decides.
 */
export const ACTION_KIND = Object.freeze({ SAFE: 'safe', MUTATING: 'mutating' });

export const ACTION_KINDS = Object.freeze({
  goto: ACTION_KIND.SAFE, goBack: ACTION_KIND.SAFE, goForward: ACTION_KIND.SAFE, scroll: ACTION_KIND.SAFE,
  hover: ACTION_KIND.SAFE, extractContent: ACTION_KIND.SAFE, evaluate: ACTION_KIND.SAFE, waitFor: ACTION_KIND.SAFE,
  screenshot: ACTION_KIND.SAFE, getPageState: ACTION_KIND.SAFE,
  click: ACTION_KIND.MUTATING, type: ACTION_KIND.MUTATING, select: ACTION_KIND.MUTATING, pressKey: ACTION_KIND.MUTATING,
  typeText: ACTION_KIND.MUTATING, clickAt: ACTION_KIND.MUTATING, doubleClickAt: ACTION_KIND.MUTATING, drag: ACTION_KIND.MUTATING,
  uploadFile: ACTION_KIND.MUTATING,
});

const CHECKPOINT_NOT_TRANSFERABLE = Object.freeze(['indexedDB', 'serviceWorkers', 'openTabs', 'inFlightRequests', 'history']);
const SENSITIVE_AUTOCOMPLETE = ['one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'new-password', 'current-password'];

export class BrowserSession {
  /**
   * @param {object} options
   * @param {'headless'|'chrome'|'visual'|'auto'|'computer-use'} options.mode - 'headless' (LightPanda), 'chrome' (pooled headless Chrome), 'visual' (Chrome visible), 'auto' (LP with Chrome fallback), 'computer-use' (provider with Xvfb+VNC)
   * @param {boolean} [options.isolate=true] - Fresh browser context per session on pooled Chrome (cookies/storage never shared)
   * @param {boolean} [options.recordTypedText=false] - Keep typed text in the action history (redacted by default)
   * @param {boolean} [options.redact=true] - Redact URLs/text in history and logs
   * @param {boolean} [options.noSandbox] - Launch Chrome without its sandbox (containers); default keeps the sandbox on
   * @param {boolean} [options.disableWebSecurity] - Disable same-origin policy in Chrome (off by default)
   * @param {number} [options.acquireTimeout=30000] - Max wait for a pooled browser
   * @param {AbortSignal} [options.signal] - Abort connecting/queued acquisition
   * @param {number} options.timeout - Navigation timeout in ms (default: 15000)
   * @param {string} options.userAgent - Custom user agent
   * @param {string} options.lightpandaPath - Path to LightPanda binary
   * @param {boolean} options.verbose - Enable logging
   * @param {import('./computer-use-provider.js').ComputerUseProvider} options.provider - Required for computer-use mode
   */
  constructor(options = {}) {
    this.mode = options.mode || 'auto';
    this.activeBackend = null; // 'lightpanda' | 'chrome' | 'computer-use'
    this.timeout = options.timeout || 15000;
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    this.lightpandaPath = options.lightpandaPath;
    this.verbose = options.verbose || false;
    this.isolate = options.isolate ?? !(options.persistent === true);
    this.recordTypedText = options.recordTypedText ?? false;
    this.redact = options.redact ?? true;
    this.acquireTimeout = options.acquireTimeout ?? 30000;
    this.signal = options.signal || null;
    this.launch = {
      ...(options.noSandbox !== undefined && { noSandbox: options.noSandbox }),
      ...(options.disableWebSecurity !== undefined && { disableWebSecurity: options.disableWebSecurity }),
    };

    this.browser = null;
    this.context = null;
    this.page = null;
    this._chromeBrowser = null; // reference for pool release
    this._connected = false;
    this._fallbackCount = 0;

    // Computer-use provider (Xvfb + Chrome + xdotool + optional VNC)
    this.provider = options.provider || null;
    this._providerInfo = null;

    this.history = []; // action log for debugging
  }

  // ── Connection ──────────────────────────────────────────────

  async connect() {
    if (this._connected) return this;

    if (this.mode === 'computer-use') {
      await this._connectViaProvider();
    } else if (this.mode === 'chrome') {
      await this._connectChrome();
    } else if (this.mode === 'visual') {
      await this._connectChromeVisual();
    } else {
      // 'headless' or 'auto' — start with LightPanda
      try {
        await this._connectLightPanda();
      } catch (err) {
        if (this.mode === 'auto') {
          this._log(`LightPanda unavailable (${err.message}), falling back to Chrome`);
          await this._connectChrome();
        } else {
          throw err;
        }
      }
    }

    this._connected = true;
    return this;
  }

  async _connectLightPanda() {
    const server = getLightPandaServer(this.lightpandaPath);
    const endpoint = await server.start();

    const puppeteer = await this._getPuppeteer();
    this.browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();

    await this.page.setUserAgent(this.userAgent);
    this.activeBackend = 'lightpanda';
    this._log('Connected to LightPanda CDP');
  }

  async _connectChrome() {
    if (Object.keys(this.launch).length > 0) browserPool.configure({ launch: this.launch });
    this._chromeBrowser = await browserPool.getBrowser({ timeout: this.acquireTimeout, signal: this.signal || undefined });
    this.browser = this._chromeBrowser;
    // Fresh context per session: cookies, storage, IndexedDB and service
    // workers never leak between sessions sharing a pooled browser.
    this.context = this.isolate ? await this.browser.createBrowserContext() : null;
    this.page = await (this.context ?? this.browser).newPage();

    await this.page.setUserAgent(this.userAgent);
    await this.page.setViewport({ width: 1280, height: 800 });
    this.activeBackend = 'chrome';
    this._log('Connected to Chrome');
  }

  async _connectChromeVisual() {
    const puppeteer = await this._getPuppeteer();
    this.browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.BNCA_CHROME_PATH || undefined,
      args: buildLaunchArgs({
        noSandbox: this.launch.noSandbox ?? process.env.BNCA_CHROME_NO_SANDBOX === '1',
        disableWebSecurity: this.launch.disableWebSecurity ?? false,
        extraArgs: ['--window-size=1280,800'],
      }),
    });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(this.userAgent);
    await this.page.setViewport({ width: 1280, height: 800 });
    this.activeBackend = 'chrome';
    this._log('Connected to Chrome (visual, headless:false)');
  }

  async _connectViaProvider() {
    if (!this.provider) {
      throw new Error('computer-use mode requires a provider. Pass { provider: new LocalProvider() }');
    }
    this._providerInfo = await this.provider.start();

    const puppeteer = await this._getPuppeteer();
    this.browser = await puppeteer.connect({
      browserWSEndpoint: this._providerInfo.cdpUrl,
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    await this.page.setViewport({
      width: this._providerInfo.screenSize.width,
      height: this._providerInfo.screenSize.height,
    });
    this.activeBackend = 'computer-use';
    this._log('Connected via ComputerUseProvider');
  }

  // ── Navigation ──────────────────────────────────────────────

  async goto(url, options = {}) {
    this._ensureConnected();
    try {
      const response = await this.page.goto(url, {
        waitUntil: options.waitUntil || 'networkidle0',
        timeout: options.timeout || this.timeout,
      });
      const httpStatus = response ? response.status() : null;
      this._logAction('goto', { url, httpStatus });
      return { success: true, outcome: 'ok', url: this.page.url(), httpStatus };
    } catch (err) {
      if (await this._shouldFallback(err)) {
        await this._fallbackToChrome(FALLBACK_REASONS.CDP_ERROR);
        return this.goto(url, options);
      }
      throw err;
    }
  }

  async goBack() {
    this._ensureConnected();
    await this.page.goBack({ waitUntil: 'networkidle0', timeout: this.timeout });
    this._logAction('goBack');
  }

  async goForward() {
    this._ensureConnected();
    await this.page.goForward({ waitUntil: 'networkidle0', timeout: this.timeout });
    this._logAction('goForward');
  }

  // ── Page Interactions ───────────────────────────────────────

  async click(selector, options = {}) {
    this._ensureConnected();
    let dispatched = false;
    try {
      await this.page.waitForSelector(selector, { timeout: options.timeout || this.timeout });
      const urlBefore = this.page.url();
      dispatched = true;
      await this.page.click(selector);

      // Wait briefly for a navigation the click may have started. A timeout
      // means "no navigation happened" (fine); any other error means the
      // request left but no usable response came back (uncertain).
      let navError = null;
      if (options.waitForNavigation !== false) {
        try {
          await this.page.waitForNavigation({ timeout: options.navigationTimeout ?? 3000, waitUntil: 'networkidle0' });
        } catch (err) {
          if (!/timeout/i.test(err.message || '')) navError = err;
        }
      }

      const urlAfter = this.page.url();
      if (navError || urlAfter.startsWith('chrome-error://')) {
        const uncertainReason = navError
          ? `navigation_error:${navError.message}`
          : 'navigation_error:response_dropped';
        this._logAction('click', { selector, outcome: 'uncertain', uncertainReason });
        return { success: false, outcome: 'uncertain', uncertainReason, error: navError?.message || 'no response after click', url: urlAfter };
      }

      // LightPanda sometimes swallows click-triggered navigation. The click
      // was dispatched, so it is not replayed: move to Chrome and report.
      if (this.activeBackend === 'lightpanda' && options.expectNavigation && urlBefore === urlAfter) {
        this._log('Click did not trigger expected navigation on LightPanda — switching to Chrome without replaying');
        await this._fallbackToChrome(FALLBACK_REASONS.NAVIGATION_FAILED);
        const uncertainReason = 'navigation_expected_not_observed';
        this._logAction('click', { selector, outcome: 'uncertain', uncertainReason });
        return { success: false, outcome: 'uncertain', uncertainReason, url: this.page.url(), backend: this.activeBackend };
      }

      this._logAction('click', { selector });
      return { success: true, outcome: 'ok', url: urlAfter };
    } catch (err) {
      if (dispatched) {
        const uncertainReason = `error_after_dispatch:${err.message}`;
        this._logAction('click', { selector, outcome: 'uncertain', uncertainReason });
        return { success: false, outcome: 'uncertain', uncertainReason, error: err.message };
      }
      if (await this._shouldFallback(err)) {
        await this._fallbackToChrome(FALLBACK_REASONS.CDP_ERROR);
        return this.click(selector, options);
      }
      throw err;
    }
  }

  async type(selector, text, options = {}) {
    this._ensureConnected();
    let dispatched = false;
    try {
      await this.page.waitForSelector(selector, { timeout: options.timeout || this.timeout });
      dispatched = true;
      if (options.clear) {
        await this.page.click(selector, { clickCount: 3 });
        await this.page.keyboard.press('Backspace');
      }
      await this.page.type(selector, text, { delay: options.delay || 0 });
      this._logAction('type', { selector, text });
      return { success: true, outcome: 'ok' };
    } catch (err) {
      if (dispatched) {
        const uncertainReason = `error_after_dispatch:${err.message}`;
        this._logAction('type', { selector, outcome: 'uncertain', uncertainReason });
        return { success: false, outcome: 'uncertain', uncertainReason, error: err.message };
      }
      if (await this._shouldFallback(err)) {
        await this._fallbackToChrome(FALLBACK_REASONS.CDP_ERROR);
        return this.type(selector, text, options);
      }
      throw err;
    }
  }

  async scroll(direction = 'down', amount = 500) {
    this._ensureConnected();
    const deltaY = direction === 'up' ? -amount : amount;
    await this.page.evaluate((dy) => window.scrollBy(0, dy), deltaY);
    this._logAction('scroll', { direction, amount });
    return { success: true, outcome: 'ok' };
  }

  async hover(selector) {
    this._ensureConnected();
    if (this.activeBackend === 'lightpanda') {
      // LP doesn't support mouseMoved — fall back
      if (this.mode === 'auto') {
        await this._fallbackToChrome(FALLBACK_REASONS.METHOD_NOT_SUPPORTED);
        return this.hover(selector);
      }
      throw new Error('hover() not supported in LightPanda mode');
    }

    await this.page.waitForSelector(selector, { timeout: this.timeout });
    await this.page.hover(selector);
    this._logAction('hover', { selector });
    return { success: true, outcome: 'ok' };
  }

  async select(selector, ...values) {
    this._ensureConnected();
    await this.page.waitForSelector(selector, { timeout: this.timeout });
    try {
      await this.page.select(selector, ...values);
    } catch (err) {
      const uncertainReason = `error_after_dispatch:${err.message}`;
      this._logAction('select', { selector, outcome: 'uncertain', uncertainReason });
      return { success: false, outcome: 'uncertain', uncertainReason, error: err.message };
    }
    this._logAction('select', { selector, values });
    return { success: true, outcome: 'ok' };
  }

  /** Page (CDP) keyboard input — works in every mode. See desktopKey() for native input. */
  async pressKey(key) {
    this._ensureConnected();
    try {
      await this.page.keyboard.press(key);
    } catch (err) {
      const uncertainReason = `error_after_dispatch:${err.message}`;
      this._logAction('pressKey', { key, outcome: 'uncertain', uncertainReason });
      return { success: false, outcome: 'uncertain', uncertainReason, error: err.message };
    }
    this._logAction('pressKey', { key });
    return { success: true, outcome: 'ok' };
  }

  // ── Content Extraction ──────────────────────────────────────

  async extractContent() {
    this._ensureConnected();
    return this.page.evaluate(() => {
      const title = document.title;
      const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => ({ level: h.tagName.toLowerCase(), text: h.textContent.trim() }))
        .filter(h => h.text.length > 0)
        .slice(0, 20);
      const paragraphs = Array.from(document.querySelectorAll('p'))
        .map(p => p.textContent.trim())
        .filter(t => t.length > 20)
        .slice(0, 15);
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
        .filter(l => l.text.length > 0 && l.href.startsWith('http'))
        .slice(0, 30);
      const bodyText = document.body?.innerText?.substring(0, 5000) || '';

      return { title, metaDescription, headings, paragraphs, links, bodyText, url: location.href };
    });
  }

  async evaluate(fn, ...args) {
    this._ensureConnected();
    return this.page.evaluate(fn, ...args);
  }

  async waitFor(selector, timeout) {
    this._ensureConnected();
    await this.page.waitForSelector(selector, { timeout: timeout || this.timeout });
    return { success: true };
  }

  // ── Screenshot ──────────────────────────────────────────────

  async screenshot(options = {}) {
    this._ensureConnected();

    // LightPanda can't screenshot — auto-fallback
    if (this.activeBackend === 'lightpanda') {
      if (this.mode === 'headless') {
        throw new Error('screenshot() not available in headless-only mode (LightPanda has no rendering engine)');
      }
      await this._fallbackToChrome(FALLBACK_REASONS.SCREENSHOT);
    }

    // type_ avoids collision with executeAction's { type: 'screenshot' }
    const imageFormat = options.type_ || (options.type !== 'screenshot' && options.type) || 'png';
    const buffer = await this.page.screenshot({
      type: imageFormat,
      fullPage: options.fullPage ?? true,
      encoding: 'base64',
    });

    this._logAction('screenshot');
    return {
      success: true,
      screenshot: `data:image/${imageFormat};base64,${buffer}`,
      backend: this.activeBackend,
    };
  }

  // ── AI Agent Interface ──────────────────────────────────────

  /**
   * Returns structured page state for AI decision-making.
   * Includes interactive elements with selectors for the AI to use.
   */
  async getPageState(options = {}) {
    this._ensureConnected();

    const state = await this.page.evaluate(() => {
      const interactiveElements = [];

      // Buttons
      document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el, i) => {
        if (el.offsetParent === null) return; // hidden
        const text = el.textContent?.trim() || el.value || el.getAttribute('aria-label') || '';
        if (!text) return;
        interactiveElements.push({
          type: 'button',
          text: text.substring(0, 100),
          selector: el.id ? `#${el.id}` : `button:nth-of-type(${i + 1})`,
          tag: el.tagName.toLowerCase(),
        });
      });

      // Links
      document.querySelectorAll('a[href]').forEach((el) => {
        if (el.offsetParent === null) return;
        const text = el.textContent?.trim();
        if (!text || text.length < 2) return;
        interactiveElements.push({
          type: 'link',
          text: text.substring(0, 100),
          href: el.href,
          selector: el.id ? `#${el.id}` : `a[href="${el.getAttribute('href')}"]`,
        });
      });

      // Inputs
      document.querySelectorAll('input, textarea, select').forEach((el) => {
        if (el.offsetParent === null || el.type === 'hidden') return;
        const label = el.getAttribute('aria-label')
          || el.placeholder
          || document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()
          || el.name
          || '';
        interactiveElements.push({
          type: el.tagName.toLowerCase() === 'select' ? 'select' : 'input',
          inputType: el.type || 'text',
          label: label.substring(0, 100),
          value: el.value?.substring(0, 50) || '',
          selector: el.id ? `#${el.id}` : `[name="${el.name}"]`,
          tag: el.tagName.toLowerCase(),
        });
      });

      return {
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.substring(0, 3000) || '',
        interactiveElements: interactiveElements.slice(0, 50),
      };
    });

    // Optionally include screenshot
    if (options.includeScreenshot && this.activeBackend !== 'lightpanda') {
      const { screenshot } = await this.screenshot();
      state.screenshot = screenshot;
    } else if (options.includeScreenshot && this.mode === 'auto') {
      await this._fallbackToChrome(FALLBACK_REASONS.SCREENSHOT);
      const { screenshot } = await this.screenshot();
      state.screenshot = screenshot;
    }

    state.backend = this.activeBackend;
    state.sessionHistory = this.history.slice(-10);

    return state;
  }

  /**
   * Execute a structured action from an AI agent.
   * @param {{ type: string, selector?: string, text?: string, url?: string, key?: string, direction?: string, amount?: number }} action
   */
  async executeAction(action) {
    switch (action.type) {
      case 'goto': return this.goto(action.url);
      case 'click': return this.click(action.selector, action);
      case 'type': return this.type(action.selector, action.text, action);
      case 'scroll': return this.scroll(action.direction, action.amount);
      case 'hover': return this.hover(action.selector);
      case 'select': return this.select(action.selector, ...(action.values || []));
      case 'pressKey': return this.pressKey(action.key);
      case 'goBack': return this.goBack();
      case 'goForward': return this.goForward();
      case 'screenshot': return this.screenshot(action);
      case 'extractContent': return this.extractContent();
      case 'waitFor': return this.waitFor(action.selector, action.timeout);
      // Coordinate-based actions (computer-use mode)
      case 'mouseMove': return this.mouseMove(action.x, action.y);
      case 'clickAt': return this.clickAt(action.x, action.y, action.button);
      case 'doubleClickAt': return this.doubleClickAt(action.x, action.y, action.button);
      case 'drag': return this.drag(action.startX, action.startY, action.endX, action.endY);
      case 'scrollAt': return this.scrollAt(action.x, action.y, action.direction, action.amount);
      case 'typeText': return this.typeText(action.text);
      case 'getCursorPosition': return this.getCursorPosition();
      case 'getScreenSize': return this.getScreenSize();
      default: throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  // ── Cookies ─────────────────────────────────────────────────

  async getCookies() {
    this._ensureConnected();
    return this.page.cookies();
  }

  async setCookies(cookies) {
    this._ensureConnected();
    if (this.activeBackend === 'lightpanda') {
      // LP doesn't support Network.deleteCookies which Puppeteer's setCookie calls.
      // Use the page's internal CDP session to call Network.setCookies directly.
      try {
        const client = this.page._client();
        await client.send('Network.setCookies', { cookies });
      } catch {
        // Fallback: set cookies via document.cookie (limited to non-httpOnly)
        for (const c of cookies) {
          const parts = [`${c.name}=${c.value}`];
          if (c.domain) parts.push(`domain=${c.domain}`);
          if (c.path) parts.push(`path=${c.path}`);
          await this.page.evaluate((cookieStr) => { document.cookie = cookieStr; }, parts.join('; '));
        }
      }
    } else {
      await this.page.setCookie(...cookies);
    }
  }

  // ── Coordinate-based actions (computer-use mode) ────────────

  _ensureProvider() {
    if (!this.provider || this.activeBackend !== 'computer-use') {
      throw new Error('Coordinate-based actions require computer-use mode with a provider');
    }
  }

  async mouseMove(x, y) {
    this._ensureConnected();
    this._ensureProvider();
    const result = await this.provider.mouseMove(x, y);
    this._logAction('mouseMove', { x, y });
    return result;
  }

  async clickAt(x, y, button = 'left') {
    this._ensureConnected();
    this._ensureProvider();
    const result = await this.provider.mouseClick(x, y, button);
    this._logAction('clickAt', { x, y, button });
    return result;
  }

  async doubleClickAt(x, y, button = 'left') {
    this._ensureConnected();
    this._ensureProvider();
    const result = await this.provider.mouseDoubleClick(x, y, button);
    this._logAction('doubleClickAt', { x, y, button });
    return result;
  }

  async drag(startX, startY, endX, endY) {
    this._ensureConnected();
    this._ensureProvider();
    const result = await this.provider.mouseDrag(startX, startY, endX, endY);
    this._logAction('drag', { startX, startY, endX, endY });
    return result;
  }

  async scrollAt(x, y, direction = 'down', amount = 3) {
    this._ensureConnected();
    this._ensureProvider();
    const result = await this.provider.scroll(x, y, direction, amount);
    this._logAction('scrollAt', { x, y, direction, amount });
    return result;
  }

  async typeText(text) {
    this._ensureConnected();
    // Use Puppeteer keyboard when we have a page — works with both selector
    // clicks (CDP focus) and coordinate clicks (X11 focus propagates to DOM).
    // xdotool typeText only reaches the X11-focused window, not the DOM-focused
    // element, so it fails when mixed with selector-based click.
    if (this.page) {
      await this.page.keyboard.type(text);
    } else {
      this._ensureProvider();
      await this.provider.typeText(text);
    }
    this._logAction('typeText', { text });
    return { success: true };
  }

  async getCursorPosition() {
    this._ensureConnected();
    this._ensureProvider();
    return this.provider.getCursorPosition();
  }

  async getScreenSize() {
    this._ensureConnected();
    this._ensureProvider();
    return this.provider.getScreenSize();
  }

  getVncUrl() {
    return this._providerInfo?.vncUrl || null;
  }

  // ── Checkpoint / restore ────────────────────────────────────

  /**
   * Capture what can be carried to another engine: URL, cookies (incl.
   * HttpOnly via CDP when available), web storage and non-sensitive form
   * values. `notTransferable` names what is lost on an engine switch.
   */
  async checkpoint() {
    this._ensureConnected();
    const captured = [];
    const cp = {
      url: this.page.url(),
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      formValues: [],
      captured,
      notTransferable: [...CHECKPOINT_NOT_TRANSFERABLE],
    };

    try {
      cp.cookies = await this._getAllCookies();
      captured.push('cookies');
    } catch (err) {
      this._log(`checkpoint: cookies unavailable (${err.message})`);
    }

    try {
      const storage = await this.page.evaluate(() => {
        const dump = (store) => {
          const out = {};
          for (let i = 0; i < store.length; i++) { const k = store.key(i); out[k] = store.getItem(k); }
          return out;
        };
        return { local: dump(localStorage), session: dump(sessionStorage) };
      });
      cp.localStorage = storage.local || {};
      cp.sessionStorage = storage.session || {};
      captured.push('localStorage', 'sessionStorage');
    } catch (err) {
      this._log(`checkpoint: storage unavailable (${err.message})`);
    }

    try {
      cp.formValues = await this.page.evaluate((sensitiveSource, sensitiveAutocomplete) => {
        const sensitive = new RegExp(sensitiveSource, 'i');
        const sensAc = new Set(sensitiveAutocomplete);
        const out = [];
        document.querySelectorAll('input, textarea, select').forEach((el) => {
          if (!el.name && !el.id) return;
          const type = (el.type || '').toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'file', 'image', 'password'].includes(type)) return;
          if (sensAc.has((el.getAttribute('autocomplete') || '').toLowerCase().trim())) return;
          const label = (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
          if ([el.name, el.id, label].some(v => v && sensitive.test(String(v)))) return;
          const selector = el.id ? `#${CSS.escape(el.id)}` : `[name=${JSON.stringify(el.name)}]`;
          const entry = { selector, tag: el.tagName.toLowerCase(), type };
          if (type === 'checkbox' || type === 'radio') entry.checked = el.checked; else entry.value = el.value;
          out.push(entry);
        });
        return out;
      }, SENSITIVE_FIELD_RE.source, SENSITIVE_AUTOCOMPLETE);
      captured.push('formValues');
    } catch (err) {
      this._log(`checkpoint: form values unavailable (${err.message})`);
    }

    return cp;
  }

  /**
   * Re-apply a checkpoint to this session. Never throws for an item the
   * browser rejects; every such item is reported in `skipped`.
   */
  async restore(cp) {
    this._ensureConnected();
    const restored = [];
    const skipped = [];
    if (!cp) return { restored, skipped };

    if (Array.isArray(cp.cookies) && cp.cookies.length > 0) {
      let ok = 0;
      for (const raw of cp.cookies) {
        const cookie = this._sanitizeCookie(raw);
        if (!cookie) { skipped.push({ item: `cookie:${raw?.name}`, reason: 'invalid cookie' }); continue; }
        try {
          await this.setCookies([cookie]);
          ok++;
        } catch (err) {
          skipped.push({ item: `cookie:${cookie.name}`, reason: err.message });
        }
      }
      if (ok > 0) restored.push('cookies');
    }

    if (cp.url && cp.url !== 'about:blank' && !cp.url.startsWith('chrome-error://')) {
      try {
        await this.page.goto(cp.url, { waitUntil: 'networkidle0', timeout: this.timeout });
        restored.push('url');
      } catch (err) {
        skipped.push({ item: 'url', reason: err.message });
        for (const item of cp.notTransferable || []) skipped.push({ item, reason: 'not transferable' });
        return { restored, skipped };
      }
    }

    const local = cp.localStorage || {};
    const session = cp.sessionStorage || {};
    if (Object.keys(local).length || Object.keys(session).length) {
      try {
        await this.page.evaluate((l, s) => {
          for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v);
          for (const [k, v] of Object.entries(s)) sessionStorage.setItem(k, v);
        }, local, session);
        if (Object.keys(local).length) restored.push('localStorage');
        if (Object.keys(session).length) restored.push('sessionStorage');
      } catch (err) {
        skipped.push({ item: 'storage', reason: err.message });
      }
    }

    if (Array.isArray(cp.formValues) && cp.formValues.length > 0) {
      try {
        const result = await this.page.evaluate((values) => {
          let applied = 0;
          const missing = [];
          for (const f of values) {
            const el = document.querySelector(f.selector);
            if (!el) { missing.push(f.selector); continue; }
            if ('checked' in f) el.checked = f.checked; else el.value = f.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            applied++;
          }
          return { applied, missing };
        }, cp.formValues);
        if (result.applied > 0) restored.push('formValues');
        for (const m of result.missing) skipped.push({ item: `form:${m}`, reason: 'element not found' });
      } catch (err) {
        skipped.push({ item: 'formValues', reason: err.message });
      }
    }

    for (const item of cp.notTransferable || []) skipped.push({ item, reason: 'not transferable' });
    return { restored, skipped };
  }

  async _getAllCookies() {
    // CDP Network.getAllCookies includes HttpOnly cookies for every domain
    try {
      const client = await this.page.createCDPSession();
      try {
        const { cookies } = await client.send('Network.getAllCookies');
        return cookies || [];
      } finally {
        await client.detach().catch(() => {});
      }
    } catch {
      return this.page.cookies();
    }
  }

  _sanitizeCookie(c) {
    if (!c || typeof c.name !== 'string') return null;
    const out = { name: c.name, value: c.value == null ? '' : String(c.value) };
    for (const key of ['domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']) {
      if (c[key] !== undefined && c[key] !== null) out[key] = c[key];
    }
    if (out.expires === -1 || out.expires === 0) delete out.expires;
    if (out.sameSite && !['Strict', 'Lax', 'None'].includes(out.sameSite)) delete out.sameSite;
    return out;
  }

  // ── Fallback ────────────────────────────────────────────────

  async _fallbackToChrome(reason) {
    if (this.activeBackend === 'chrome') return; // already on Chrome
    if (this._fallbackCount > 2) throw new Error('Too many fallback attempts');

    this._log(`Falling back to Chrome: ${reason}`);
    this._fallbackCount++;
    const from = this.activeBackend;

    // Capture everything we can carry over; LP may be in a bad state.
    let cp = null;
    try {
      cp = await this.checkpoint();
    } catch (err) {
      this._log(`checkpoint failed before fallback: ${err.message}`);
    }

    // Close LP page (keep server alive for potential reuse)
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.disconnect();
    } catch {
      // ignore cleanup errors
    }

    await this._connectChrome();

    const { restored, skipped } = await this.restore(cp);
    this._logAction('fallback', {
      reason,
      from,
      to: 'chrome',
      restored,
      skipped: skipped.filter(s => s.reason !== 'not transferable').map(s => s.item),
      notTransferable: cp?.notTransferable || [...CHECKPOINT_NOT_TRANSFERABLE],
    });
  }

  async _shouldFallback(error) {
    if (this.activeBackend === 'chrome') return false;
    if (this.mode === 'headless') return false; // no auto-fallback in explicit headless mode

    const msg = error.message || '';
    return (
      msg.includes('Protocol error') ||
      msg.includes('not implemented') ||
      msg.includes('Target closed') ||
      msg.includes('Session closed') ||
      msg.includes('Connection closed') ||
      msg.includes('Execution context was destroyed')
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────

  async close() {
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
    } catch { /* ignore */ }

    try {
      if (this.context) await this.context.close();
    } catch { /* ignore */ }

    if (this.activeBackend === 'computer-use') {
      // Provider mode: disconnect from CDP, then stop the provider
      try { if (this.browser) await this.browser.disconnect(); } catch { /* ignore */ }
      try { if (this.provider) await this.provider.stop(); } catch { /* ignore */ }
    } else if (this.activeBackend === 'lightpanda' && this.browser) {
      try { await this.browser.disconnect(); } catch { /* ignore */ }
    } else if (this.mode === 'visual' && this.browser && !this._chromeBrowser) {
      // Visual mode: launched directly, not from pool — close the browser process
      try { await this.browser.close(); } catch { /* ignore */ }
    }

    if (this._chromeBrowser) {
      browserPool.releaseBrowser(this._chromeBrowser);
      this._chromeBrowser = null;
    }

    this.page = null;
    this.context = null;
    this.browser = null;
    this._connected = false;
    this._log('Session closed');
  }

  // ── Helpers ─────────────────────────────────────────────────

  _ensureConnected() {
    if (!this._connected || !this.page) {
      throw new Error('Session not connected. Call connect() first.');
    }
  }

  async _getPuppeteer() {
    try {
      const puppeteer = await import('puppeteer');
      return puppeteer.default || puppeteer;
    } catch {
      throw new Error('Puppeteer is required for BrowserSession. Install with: npm install puppeteer');
    }
  }

  _log(msg) {
    if (this.verbose) console.log(`[BrowserSession] ${msg}`);
  }

  _logAction(type, params = {}) {
    const safe = this._redactParams(params);
    const entry = { type, ...safe, timestamp: Date.now(), backend: this.activeBackend };
    this.history.push(entry);
    this._log(`${type} ${JSON.stringify(safe)}`);
    return entry;
  }

  /** Strip typed text (unless recordTypedText) and mask URL secrets before anything is recorded. */
  _redactParams(params) {
    if (!this.redact) return params;
    const out = { ...params };
    if ('text' in out && !this.recordTypedText) {
      out.textLength = out.text == null ? 0 : String(out.text).length;
      delete out.text;
    }
    if (typeof out.url === 'string') out.url = redactUrl(out.url);
    return out;
  }

  getHistory() {
    return this.history;
  }

  getBackend() {
    return this.activeBackend;
  }
}

/**
 * Convenience function to create and connect a browser session.
 */
export async function createSession(options = {}) {
  const session = new BrowserSession(options);
  await session.connect();
  return session;
}

export default BrowserSession;
