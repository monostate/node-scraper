import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession, createSession } from '../browser-session.js';
import { ComputerUseProvider } from '../computer-use-provider.js';
import browserPool from '../browser-pool.js';

const TIMEOUT = 20000;

// ─── Mock Provider ──────────────────────────────────────────────────────────

class MockProvider extends ComputerUseProvider {
  constructor() {
    super();
    this.calls = [];
    this.started = false;
    this.stopped = false;
    this._cdpUrl = null;
  }

  async start() {
    this.calls.push(['start']);
    this.started = true;

    // Launch a real headless Chrome to get a CDP URL for Puppeteer to connect to
    const puppeteer = (await import('puppeteer')).default;
    this._browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    this._cdpUrl = this._browser.wsEndpoint();

    return {
      cdpUrl: this._cdpUrl,
      vncUrl: 'vnc://mock:5900',
      screenSize: { width: 1280, height: 800 },
    };
  }

  async stop() {
    this.calls.push(['stop']);
    this.stopped = true;
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }

  async screenshot() {
    this.calls.push(['screenshot']);
    return { screenshot: 'data:image/png;base64,MOCK_SCREENSHOT' };
  }

  async mouseMove(x, y) {
    this.calls.push(['mouseMove', x, y]);
    return { success: true };
  }

  async mouseClick(x, y, button) {
    this.calls.push(['mouseClick', x, y, button]);
    return { success: true };
  }

  async mouseDoubleClick(x, y, button) {
    this.calls.push(['mouseDoubleClick', x, y, button]);
    return { success: true };
  }

  async mouseDrag(startX, startY, endX, endY) {
    this.calls.push(['mouseDrag', startX, startY, endX, endY]);
    return { success: true };
  }

  async scroll(x, y, direction, amount) {
    this.calls.push(['scroll', x, y, direction, amount]);
    return { success: true };
  }

  async pressKey(key) {
    this.calls.push(['pressKey', key]);
    return { success: true };
  }

  async typeText(text) {
    this.calls.push(['typeText', text]);
    return { success: true };
  }

  async getCursorPosition() {
    this.calls.push(['getCursorPosition']);
    return { x: 640, y: 400 };
  }

  async getScreenSize() {
    this.calls.push(['getScreenSize']);
    return { width: 1280, height: 800 };
  }
}

// ─── 1. Constructor with provider ────────────────────────────────────────────

describe('BrowserSession computer-use constructor', () => {
  it('accepts provider option', () => {
    const provider = new MockProvider();
    const s = new BrowserSession({ mode: 'computer-use', provider });
    assert.equal(s.mode, 'computer-use');
    assert.equal(s.provider, provider);
  });

  it('throws if computer-use mode without provider', async () => {
    const s = new BrowserSession({ mode: 'computer-use' });
    await assert.rejects(() => s.connect(), /requires a provider/i);
  });
});

// ─── 2. Connect via provider ─────────────────────────────────────────────────

describe('BrowserSession computer-use mode', { timeout: TIMEOUT }, () => {
  let session;
  let provider;

  before(async () => {
    provider = new MockProvider();
    session = await createSession({ mode: 'computer-use', provider });
  });

  after(async () => {
    await session.close();
  });

  it('connects with computer-use backend', () => {
    assert.equal(session.activeBackend, 'computer-use');
    assert.ok(session.page);
  });

  it('provider.start() was called', () => {
    assert.equal(provider.started, true);
    assert.deepEqual(provider.calls[0], ['start']);
  });

  it('returns vncUrl', () => {
    assert.equal(session.getVncUrl(), 'vnc://mock:5900');
  });

  // Selector-based actions still work through Puppeteer CDP
  it('navigates to a URL via Puppeteer', async () => {
    const result = await session.goto('https://example.com');
    assert.equal(result.success, true);
    assert.ok(result.url.includes('example.com'));
  });

  // Coordinate-based actions delegate to provider
  it('mouseMove delegates to provider', async () => {
    const result = await session.mouseMove(100, 200);
    assert.equal(result.success, true);
    const call = provider.calls.find(c => c[0] === 'mouseMove');
    assert.deepEqual(call, ['mouseMove', 100, 200]);
  });

  it('clickAt delegates to provider', async () => {
    const result = await session.clickAt(640, 400, 'left');
    assert.equal(result.success, true);
    const call = provider.calls.find(c => c[0] === 'mouseClick');
    assert.deepEqual(call, ['mouseClick', 640, 400, 'left']);
  });

  it('doubleClickAt delegates to provider', async () => {
    const result = await session.doubleClickAt(300, 150, 'left');
    assert.equal(result.success, true);
    const call = provider.calls.find(c => c[0] === 'mouseDoubleClick');
    assert.deepEqual(call, ['mouseDoubleClick', 300, 150, 'left']);
  });

  it('drag delegates to provider', async () => {
    const result = await session.drag(10, 20, 100, 200);
    assert.equal(result.success, true);
    const call = provider.calls.find(c => c[0] === 'mouseDrag');
    assert.deepEqual(call, ['mouseDrag', 10, 20, 100, 200]);
  });

  it('scrollAt delegates to provider', async () => {
    const result = await session.scrollAt(640, 400, 'down', 5);
    assert.equal(result.success, true);
    const call = provider.calls.find(c => c[0] === 'scroll');
    assert.deepEqual(call, ['scroll', 640, 400, 'down', 5]);
  });

  it('typeText uses page.keyboard.type when page exists', async () => {
    const result = await session.typeText('hello world');
    assert.equal(result.success, true);
    // typeText uses page.keyboard.type() instead of provider.typeText()
    // because xdotool typing doesn't reach DOM-focused elements
    const call = provider.calls.find(c => c[0] === 'typeText');
    assert.equal(call, undefined, 'should NOT delegate to provider when page exists');
  });

  it('getCursorPosition delegates to provider', async () => {
    const result = await session.getCursorPosition();
    assert.equal(result.x, 640);
    assert.equal(result.y, 400);
  });

  it('getScreenSize delegates to provider', async () => {
    const result = await session.getScreenSize();
    assert.equal(result.width, 1280);
    assert.equal(result.height, 800);
  });

  it('executeAction routes coordinate actions', async () => {
    provider.calls.length = 0;
    await session.executeAction({ type: 'clickAt', x: 50, y: 60 });
    const call = provider.calls.find(c => c[0] === 'mouseClick');
    assert.ok(call, 'mouseClick should have been called');
    assert.equal(call[1], 50);
    assert.equal(call[2], 60);
  });
});

// ─── 3. Coordinate actions throw outside computer-use mode ──────────────────

describe('Coordinate actions in non-computer-use mode', { timeout: TIMEOUT }, () => {
  let session;

  before(async () => {
    session = await createSession({ mode: 'visual', verbose: false });
  });

  after(async () => {
    await session.close();
    await browserPool.closeAll();
  });

  it('mouseMove throws', async () => {
    await assert.rejects(() => session.mouseMove(100, 200), /computer-use mode/i);
  });

  it('clickAt throws', async () => {
    await assert.rejects(() => session.clickAt(100, 200), /computer-use mode/i);
  });

  it('typeText works (uses page.keyboard)', async () => {
    // typeText uses page.keyboard.type() when page exists, so it works in any mode
    const result = await session.typeText('test');
    assert.equal(result.success, true);
  });

  it('getVncUrl returns null', () => {
    assert.equal(session.getVncUrl(), null);
  });
});

// ─── 4. Visual mode fix ─────────────────────────────────────────────────────

describe('Visual mode fix', { timeout: TIMEOUT }, () => {
  let session;

  before(async () => {
    session = await createSession({ mode: 'visual', verbose: false });
  });

  after(async () => {
    await session.close();
    await browserPool.closeAll();
  });

  it('connects with chrome backend', () => {
    assert.equal(session.activeBackend, 'chrome');
  });

  it('navigates and loads content', async () => {
    const result = await session.goto('https://example.com');
    assert.equal(result.success, true);
    const content = await session.extractContent();
    assert.ok(content.title.includes('Example'));
  });

  it('takes a screenshot', async () => {
    const result = await session.screenshot();
    assert.equal(result.success, true);
    assert.ok(result.screenshot.length > 100);
  });
});

// ─── 5. Provider cleanup on close ───────────────────────────────────────────

describe('Provider cleanup', { timeout: TIMEOUT }, () => {
  it('calls provider.stop() on close', async () => {
    const provider = new MockProvider();
    const session = await createSession({ mode: 'computer-use', provider });
    assert.equal(provider.stopped, false);
    await session.close();
    assert.equal(provider.stopped, true);
    const stopCall = provider.calls.find(c => c[0] === 'stop');
    assert.ok(stopCall, 'stop should have been called');
  });
});
