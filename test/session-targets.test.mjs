import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../browser-session.js';
import browserPool from '../browser-pool.js';
import { startFixtureServer } from './fixtures/server.mjs';

let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const skip = !chromeAvailable && 'Puppeteer not installed';

describe('frames, shadow roots and tabs', { timeout: 60000, skip }, () => {
  let fx, s, otherPages;
  before(async () => {
    fx = await startFixtureServer();
    s = await createSession({ mode: 'chrome' });
    otherPages = (await s.browser.pages()).filter(p => p !== s.page).length; // pages that are not ours
    await s.goto(`${fx.url}/frames`);
  });
  after(async () => { await browserPool.closeAll(); await fx.close(); });

  it('lists the main frame and the iframe', async () => {
    const frames = await s.frames();
    assert.equal(frames.length, 2);
    const main = frames.find(f => f.isMain);
    const inner = frames.find(f => f.name === 'inner');
    assert.ok(main && inner);
    assert.equal(inner.parentId, main.id);
    assert.match(inner.url, /\/frames\/inner$/);
  });

  it('useFrame() routes selector actions into the iframe', async () => {
    const target = await s.useFrame('inner');
    assert.match(target.url, /\/frames\/inner$/);
    await s.click('#inner-btn', { waitForNavigation: false });
    assert.equal(await s.evaluate(() => document.title), 'inner clicked');
    const state = await s.getPageState();
    assert.ok(state.elements.some(e => e.id === 'inner-btn'));
    assert.equal(state.frame.isMain, false);
    s.useMainFrame();
    assert.equal(await s.evaluate(() => document.title), 'Frames and shadow DOM');
  });

  it('useFrame() rejects unknown targets', async () => {
    await assert.rejects(() => s.useFrame('nope'), /frame not found/i);
  });

  it('clicks an element inside an open shadow root via its page-state ref', async () => {
    const state = await s.getPageState();
    const shadowBtn = state.elements.find(e => e.id === 'shadow-btn');
    assert.ok(shadowBtn?.inShadow);
    const r = await s.click(shadowBtn.selector, { waitForNavigation: false });
    assert.equal(r.success, true);
    assert.equal(await s.evaluate(() => document.title), 'shadow clicked');
  });

  it('a target=_blank link opens a new tab the session can switch to', async () => {
    const [opened] = await Promise.all([
      s.waitForNewPage({ timeout: 10000 }),
      s.click('#new-tab', { waitForNavigation: false }),
    ]);
    assert.match(opened.url, /\/content$/);
    const pages = await s.pages();
    assert.equal(pages.length, 2);
    assert.equal(pages.filter(p => p.active).length, 1);
    await s.usePage(opened.index);
    const content = await s.extractContent();
    assert.match(content.url, /\/content$/);
    assert.equal(content.title, 'Local article fixture');
    await s.usePage(0);
    assert.equal(await s.evaluate(() => document.title), 'shadow clicked');
  });

  it('close() closes every page the session opened', async () => {
    const browser = s.browser;
    const ours = (await s.pages()).map(p => p.url);
    assert.equal(ours.length, 2);
    await s.close();
    const remaining = await browser.pages();
    assert.equal(remaining.length, otherPages);
    assert.ok(remaining.every(p => !ours.includes(p.url())));
  });
});
