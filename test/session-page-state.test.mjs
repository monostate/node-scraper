import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../browser-session.js';
import browserPool from '../browser-pool.js';
import { startFixtureServer } from './fixtures/server.mjs';

let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const skip = !chromeAvailable && 'Puppeteer not installed';

describe('BrowserSession.getPageState v2', { timeout: 60000, skip }, () => {
  let fx, s;
  before(async () => { fx = await startFixtureServer(); s = await createSession({ mode: 'chrome' }); });
  after(async () => { await s.close(); await browserPool.closeAll(); await fx.close(); });

  it('returns structured elements with refs, truncation metadata and coordinate space', async () => {
    await s.goto(`${fx.url}/many-controls`);
    const state = await s.getPageState({ maxElements: 50 });
    assert.equal(state.elements.length, 50);
    assert.equal(state.truncated.elements, true);
    assert.equal(state.truncated.total, 121);
    assert.equal(state.truncated.text, false);
    assert.equal(state.coordinateSpace, 'page');
    assert.equal(state.backend, 'chrome');
    assert.ok(Array.isArray(state.sessionHistory));
    const tail = await s.getPageState({ maxElements: 50, offset: 100 });
    const weird = tail.elements.find(e => e.text === 'Weird id');
    const r = await s.click(weird.selector, { waitForNavigation: false });
    assert.equal(r.success, true);
  });

  it('respects constructor defaults maxStateText/maxStateElements', async () => {
    const t = await createSession({ mode: 'chrome', maxStateText: 80, maxStateElements: 5 });
    await t.goto(`${fx.url}/many-controls`);
    const state = await t.getPageState();
    await t.close();
    assert.equal(state.elements.length, 5);
    assert.equal(state.text.length, 80);
    assert.equal(state.truncated.text, true);
  });

  it('redacts sensitive values and keeps interactiveElements as a compatibility alias', async () => {
    await s.goto(`${fx.url}/password`);
    await s.type('#pw', 'hunter2');
    const state = await s.getPageState();
    assert.doesNotMatch(JSON.stringify(state), /hunter2/);
    assert.equal(state.interactiveElements, state.elements);
    assert.ok(state.forms.length >= 1);
  });

  it('includeValues:false omits values entirely', async () => {
    await s.goto(`${fx.url}/forms/basic`);
    await s.type('#name', 'Visible Name');
    const state = await s.getPageState({ includeValues: false });
    const name = state.elements.find(e => e.id === 'name');
    assert.equal('value' in name, false);
  });

  it('includeScreenshot adds a page-space screenshot', async () => {
    await s.goto(`${fx.url}/content`);
    const state = await s.getPageState({ includeScreenshot: true });
    assert.match(state.screenshot, /^data:image\/png;base64,/);
  });
});

describe('dialog handling', { timeout: 60000, skip }, () => {
  let fx, s;
  before(async () => { fx = await startFixtureServer(); s = await createSession({ mode: 'chrome' }); await s.goto(`${fx.url}/dialogs`); });
  after(async () => { await s.close(); await browserPool.closeAll(); await fx.close(); });

  it('dismisses dialogs by default and records them', async () => {
    await s.click('#confirm', { waitForNavigation: false });
    assert.equal(await s.evaluate(() => document.getElementById('result').textContent), 'confirm:false');
    const dialogs = s.getDialogs();
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].type, 'confirm');
    assert.equal(dialogs[0].message, 'ok?');
    assert.equal(dialogs[0].action, 'dismiss');
    assert.ok(typeof dialogs[0].at === 'number');
  });

  it('accepts with prompt text when configured', async () => {
    s.setDialogHandler({ action: 'accept', promptText: 'hi' });
    await s.click('#prompt', { waitForNavigation: false });
    assert.equal(await s.evaluate(() => document.getElementById('result').textContent), 'prompt:hi');
    assert.equal(s.getDialogs().at(-1).type, 'prompt');
    assert.equal(s.getDialogs().at(-1).defaultValue, 'default');
  });

  it('supports an async decision function', async () => {
    s.setDialogHandler(async (d) => ({ action: d.type === 'confirm' ? 'accept' : 'dismiss' }));
    await s.click('#confirm', { waitForNavigation: false });
    assert.equal(await s.evaluate(() => document.getElementById('result').textContent), 'confirm:true');
    await s.click('#alert', { waitForNavigation: false });
    assert.equal(await s.evaluate(() => document.getElementById('result').textContent), 'alert done');
    assert.equal(s.getDialogs().at(-1).type, 'alert');
  });
});
