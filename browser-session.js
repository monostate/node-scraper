import { getLightPandaServer, stopLightPandaServer } from './lightpanda-server.js';
import browserPool from './browser-pool.js';

const FALLBACK_REASONS = {
  SCREENSHOT: 'screenshot_requested',
  CDP_ERROR: 'cdp_protocol_error',
  BOT_DETECTION: 'bot_detection',
  NAVIGATION_FAILED: 'navigation_after_click_failed',
  METHOD_NOT_SUPPORTED: 'method_not_supported',
};

export class BrowserSession {
  /**
   * @param {object} options
   * @param {'headless'|'visual'|'auto'|'computer-use'} options.mode - 'headless' (LightPanda), 'visual' (Chrome visible), 'auto' (LP with Chrome fallback), 'computer-use' (provider with Xvfb+VNC)
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
    this._chromeBrowser = await browserPool.getBrowser();
    this.browser = this._chromeBrowser;
    this.page = await this.browser.newPage();

    await this.page.setUserAgent(this.userAgent);
    await this.page.setViewport({ width: 1280, height: 800 });
    this.activeBackend = 'chrome';
    this._log('Connected to Chrome');
  }

  async _connectChromeVisual() {
    const puppeteer = await this._getPuppeteer();
    this.browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1280,800',
      ],
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

  async goto(url) {
    this._ensureConnected();
    try {
      await this.page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: this.timeout,
      });
      this._logAction('goto', { url });
      return { success: true, url: this.page.url() };
    } catch (err) {
      if (await this._shouldFallback(err)) {
        await this._fallbackToChrome(FALLBACK_REASONS.CDP_ERROR);
        return this.goto(url);
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
    try {
      await this.page.waitForSelector(selector, { timeout: options.timeout || this.timeout });
      const urlBefore = this.page.url();
      await this.page.click(selector);

      // If navigation expected, wait briefly
      if (options.waitForNavigation !== false) {
        try {
          await this.page.waitForNavigation({ timeout: 3000, waitUntil: 'networkidle0' }).catch(() => {});
        } catch {
          // No navigation happened, that's fine
        }
      }

      this._logAction('click', { selector });

      // Check for LP's known click-navigation bug
      if (this.activeBackend === 'lightpanda') {
        const urlAfter = this.page.url();
        if (options.expectNavigation && urlBefore === urlAfter) {
          this._log('Click did not trigger expected navigation — falling back to Chrome');
          await this._fallbackToChrome(FALLBACK_REASONS.NAVIGATION_FAILED);
          return this.click(selector, { ...options, _retried: true });
        }
      }

      return { success: true, url: this.page.url() };
    } catch (err) {
      if (await this._shouldFallback(err)) {
        await this._fallbackToChrome(FALLBACK_REASONS.CDP_ERROR);
        return this.click(selector, options);
      }
      throw err;
    }
  }

  async type(selector, text, options = {}) {
    this._ensureConnected();
    try {
      await this.page.waitForSelector(selector, { timeout: options.timeout || this.timeout });

      if (options.clear) {
        await this.page.click(selector, { clickCount: 3 });
        await this.page.keyboard.press('Backspace');
      }

      await this.page.type(selector, text, { delay: options.delay || 0 });
      this._logAction('type', { selector, text: text.substring(0, 20) + (text.length > 20 ? '...' : '') });
      return { success: true };
    } catch (err) {
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
    return { success: true };
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
    return { success: true };
  }

  async select(selector, ...values) {
    this._ensureConnected();
    await this.page.waitForSelector(selector, { timeout: this.timeout });
    await this.page.select(selector, ...values);
    this._logAction('select', { selector, values });
    return { success: true };
  }

  async pressKey(key) {
    this._ensureConnected();
    await this.page.keyboard.press(key);
    this._logAction('pressKey', { key });
    return { success: true };
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
    this._logAction('typeText', { text: text.substring(0, 20) + (text.length > 20 ? '...' : '') });
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

  // ── Fallback ────────────────────────────────────────────────

  async _fallbackToChrome(reason) {
    if (this.activeBackend === 'chrome') return; // already on Chrome
    if (this._fallbackCount > 2) throw new Error('Too many fallback attempts');

    this._log(`Falling back to Chrome: ${reason}`);
    this._fallbackCount++;

    // Save state from LP session
    let cookies = [];
    let currentUrl = null;
    try {
      cookies = await this.page.cookies();
      currentUrl = this.page.url();
    } catch {
      // LP might be in a bad state
    }

    // Close LP page (keep server alive for potential reuse)
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.disconnect();
    } catch {
      // ignore cleanup errors
    }

    // Connect to Chrome
    await this._connectChrome();

    // Restore state
    if (cookies.length > 0) {
      await this.page.setCookie(...cookies);
    }
    if (currentUrl && currentUrl !== 'about:blank') {
      await this.page.goto(currentUrl, {
        waitUntil: 'networkidle0',
        timeout: this.timeout,
      });
    }

    this._logAction('fallback', { reason, from: 'lightpanda', to: 'chrome' });
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
    const entry = { type, ...params, timestamp: Date.now(), backend: this.activeBackend };
    this.history.push(entry);
    this._log(`${type} ${JSON.stringify(params)}`);
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
