import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../browser-session.js';
import { ComputerUseProvider } from '../computer-use-provider.js';
import browserPool from '../browser-pool.js';
import { startFixtureServer } from './fixtures/server.mjs';

let puppeteer = null;
try { puppeteer = (await import('puppeteer')).default; } catch { /* none */ }
const skip = !puppeteer && 'Puppeteer not installed';

/** Mock provider backed by a real headless Chrome so the session has a page. */
class MockProvider extends ComputerUseProvider {
  constructor() { super(); this.calls = []; }
  async start() {
    this._browser = await puppeteer.launch({ headless: true });
    return { cdpUrl: this._browser.wsEndpoint(), vncUrl: null, vnc: null, screenSize: { width: 1280, height: 800 } };
  }
  async stop() { await this._browser?.close(); this._browser = null; }
  async screenshot({ space = 'desktop' } = {}) { this.calls.push(['screenshot', space]); return { screenshot: 'data:image/png;base64,MOCK', coordinateSpace: 'desktop', width: 1280, height: 800, dpr: 1 }; }
  async getCapabilities() { return { desktopScreenshot: true, pageScreenshot: true, vnc: false, nativeInput: true }; }
  async mouseMove(x, y) { this.calls.push(['mouseMove', x, y]); return { success: true }; }
  async mouseDown(x, y, b) { this.calls.push(['mouseDown', x, y, b]); return { success: true }; }
  async mouseUp(b) { this.calls.push(['mouseUp', b]); return { success: true }; }
  async mouseClick(x, y, b) { this.calls.push(['mouseClick', x, y, b]); return { success: true }; }
  async mouseDoubleClick(x, y, b) { this.calls.push(['mouseDoubleClick', x, y, b]); return { success: true }; }
  async mouseDrag(sx, sy, ex, ey, opts) { this.calls.push(['mouseDrag', sx, sy, ex, ey, opts]); return { success: true }; }
  async scroll(x, y, d, a) { this.calls.push(['scroll', x, y, d, a]); return { success: true }; }
  async pressKey(k) { this.calls.push(['pressKey', k]); return { success: true }; }
  async typeText(t) { this.calls.push(['typeText', t]); return { success: true }; }
  async getCursorPosition() { return { x: 0, y: 0 }; }
  async getScreenSize() { return { width: 1280, height: 800 }; }
}

describe('computer-use coordinate spaces and input split', { timeout: 60000, skip }, () => {
  let fx, s, provider;
  before(async () => {
    fx = await startFixtureServer();
    provider = new MockProvider();
    s = await createSession({ mode: 'computer-use', provider });
    await s.goto(`${fx.url}/interaction`);
  });
  after(async () => { await s.close(); await browserPool.closeAll(); await fx.close(); });
  beforeEach(() => { provider.calls.length = 0; });

  const stubGeometry = () => { s._geometry = { screen: { width: 1280, height: 800 }, viewport: { width: 1280, height: 647 }, dpr: 1, offset: { x: 10, y: 153 }, method: 'calibrated' }; };

  it('clickAt converts page coordinates to desktop pixels through the geometry', async () => {
    stubGeometry();
    await s.clickAt(10, 20, { space: 'page' });
    assert.deepEqual(provider.calls.at(-1), ['mouseClick', 20, 173, 'left']);
  });

  it('clickAt defaults to desktop space and keeps the legacy button argument', async () => {
    stubGeometry();
    await s.clickAt(10, 20, 'right');
    assert.deepEqual(provider.calls.at(-1), ['mouseClick', 10, 20, 'right']);
    await s.clickAt(5, 6, { button: 'middle' });
    assert.deepEqual(provider.calls.at(-1), ['mouseClick', 5, 6, 'middle']);
  });

  it('doubleClickAt, mouseMove, scrollAt and drag honour space:page', async () => {
    stubGeometry();
    await s.doubleClickAt(1, 2, { space: 'page' });
    assert.deepEqual(provider.calls.at(-1), ['mouseDoubleClick', 11, 155, 'left']);
    await s.mouseMove(1, 2, { space: 'page' });
    assert.deepEqual(provider.calls.at(-1), ['mouseMove', 11, 155]);
    await s.scrollAt(1, 2, 'down', 4, { space: 'page' });
    assert.deepEqual(provider.calls.at(-1), ['scroll', 11, 155, 'down', 4]);
    await s.drag(0, 0, 10, 10, { space: 'page', steps: 3, stepDelayMs: 1 });
    const d = provider.calls.at(-1);
    assert.deepEqual(d.slice(0, 5), ['mouseDrag', 10, 153, 20, 163]);
    assert.equal(d[5].steps, 3);
  });

  it('screenshot() defaults to the desktop space in computer-use mode and can ask for the page', async () => {
    const desk = await s.screenshot();
    assert.equal(desk.coordinateSpace, 'desktop');
    assert.equal(desk.width, 1280);
    assert.deepEqual(provider.calls.at(-1), ['screenshot', 'desktop']);
    const page = await s.screenshot({ space: 'page', fullPage: false });
    assert.equal(page.coordinateSpace, 'page');
    assert.match(page.screenshot, /^data:image\/png;base64,/);
    assert.ok(page.width > 0 && page.height > 0);
    assert.ok(page.offset && typeof page.offset.x === 'number');
  });

  it('pressKey/typeText are page input; desktopKey/desktopType are native input', async () => {
    await s.click('#cursor-input', { waitForNavigation: false });
    await s.pressKey('Enter');
    await s.typeText('abc');
    assert.equal(provider.calls.some(c => c[0] === 'pressKey' || c[0] === 'typeText'), false);
    assert.equal(await s.evaluate(() => document.querySelector('#cursor-input').value), 'abc');
    await s.desktopKey('Enter');
    assert.deepEqual(provider.calls.at(-1), ['pressKey', 'Return']);
    await s.desktopKey('Control+Shift+ArrowLeft');
    assert.deepEqual(provider.calls.at(-1), ['pressKey', 'ctrl+shift+Left']);
    await s.desktopType('native text');
    assert.deepEqual(provider.calls.at(-1), ['typeText', 'native text']);
  });

  it('typeText with nothing focused returns an uncertain outcome instead of typing into the void', async () => {
    await s.evaluate(() => document.activeElement?.blur());
    const r = await s.typeText('lost');
    assert.equal(r.success, false);
    assert.equal(r.outcome, 'uncertain');
    assert.equal(r.uncertainReason, 'no_focused_editable');
    assert.equal(await s.evaluate(() => document.querySelector('#cursor-input').value), 'abc');
  });

  it('executeAction routes desktopKey/desktopType and space options', async () => {
    stubGeometry();
    await s.executeAction({ type: 'desktopKey', key: 'Escape' });
    assert.deepEqual(provider.calls.at(-1), ['pressKey', 'Escape']);
    await s.executeAction({ type: 'desktopType', text: 'x' });
    assert.deepEqual(provider.calls.at(-1), ['typeText', 'x']);
    await s.executeAction({ type: 'clickAt', x: 1, y: 1, space: 'page' });
    assert.deepEqual(provider.calls.at(-1), ['mouseClick', 11, 154, 'left']);
  });

  it('getGeometry() uses window bounds when not calibrated, and calibrate() falls back cleanly on a mock', async () => {
    s._geometry = null;
    const g = await s.getGeometry();
    assert.equal(g.method, 'window-bounds');
    assert.ok(g.viewport.width > 0 && g.viewport.height > 0);
    assert.ok(typeof g.offset.x === 'number' && typeof g.offset.y === 'number');
    assert.ok(g.dpr >= 1);
    const t0 = Date.now();
    const c = await s.calibrate({ timeout: 500 });
    assert.ok(['calibrated', 'window-bounds'].includes(c.method));
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(provider.calls.some(x => x[0] === 'mouseMove'), 'calibration moved the desktop cursor');
  });
});
