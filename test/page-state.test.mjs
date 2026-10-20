import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { collectPageState, DEFAULT_REF_ATTR } from '../page-state.js';
import { SENSITIVE_FIELD_RE } from '../redact.js';
import { startFixtureServer } from './fixtures/server.mjs';

let puppeteer = null;
try { puppeteer = (await import('puppeteer')).default; } catch { /* no chrome */ }
const skip = !puppeteer && 'Puppeteer not installed';

// Runs the collector inside a real page, exactly as BrowserSession does.
describe('collectPageState (in-page collector)', { timeout: 60000, skip }, () => {
  let fx, browser, page;
  const opts = (extra = {}) => ({ maxText: 3000, maxElements: 50, offset: 0, includeValues: true, sensitiveRe: SENSITIVE_FIELD_RE.source, refAttr: DEFAULT_REF_ATTR, ...extra });
  const collect = (extra) => page.evaluate(collectPageState, opts(extra));

  before(async () => {
    fx = await startFixtureServer();
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
  });
  after(async () => { await browser.close(); await fx.close(); });

  it('reports totals, truncation and pagination over many controls', async () => {
    await page.goto(`${fx.url}/many-controls`);
    const first = await collect();
    assert.equal(first.elementsTotal, 121);
    assert.equal(first.elements.length, 50);
    assert.equal(first.elementsTruncated, true);
    const tail = await collect({ offset: 100 });
    assert.equal(tail.elements.length, 21);
    assert.equal(tail.elementsTruncated, false);
    const weird = tail.elements.find(e => e.text === 'Weird id');
    assert.ok(weird, 'weird-id button collected');
    assert.match(weird.selector, /^\[data-bnca-ref="e\d+"\]$/);
    const clicked = await page.evaluate((sel) => { const el = document.querySelector(sel); el.textContent = 'hit'; return el.id; }, weird.selector);
    assert.equal(clicked, 'we!rd:id');
  });

  it('refs are stable across repeated collection', async () => {
    await page.goto(`${fx.url}/forms/basic`);
    const a = await collect();
    const b = await collect();
    const nameA = a.elements.find(e => e.name === 'name');
    const nameB = b.elements.find(e => e.name === 'name');
    assert.equal(nameA.ref, nameB.ref);
    assert.equal(nameA.selector, nameB.selector);
  });

  it('redacts password and one-time-code values but keeps ordinary values', async () => {
    await page.goto(`${fx.url}/password`);
    await page.type('#user', 'bob');
    await page.type('#pw', 'hunter2');
    await page.type('#otp', '123456');
    const state = await collect();
    const by = (id) => state.elements.find(e => e.selector && e.id === id);
    assert.equal(by('user').value, 'bob');
    assert.equal(by('pw').value, '[redacted]');
    assert.equal(by('otp').value, '[redacted]');
    assert.doesNotMatch(JSON.stringify(state), /hunter2|123456/);
  });

  it('includes elements inside open shadow roots and marks them', async () => {
    await page.goto(`${fx.url}/frames`);
    const state = await collect();
    const shadowBtn = state.elements.find(e => e.id === 'shadow-btn');
    assert.ok(shadowBtn, 'shadow button collected');
    assert.equal(shadowBtn.inShadow, true);
    const shadowPass = state.elements.find(e => e.id === 'shadow-pass');
    assert.equal(shadowPass.value, '[redacted]');
    assert.equal(shadowPass.inShadow, true);
  });

  it('reports required/disabled/checked/invalid state, labels, bounds and form validity', async () => {
    await page.goto(`${fx.url}/forms/basic`);
    await page.evaluate(() => document.getElementById('application').reportValidity());
    const state = await collect();
    const name = state.elements.find(e => e.name === 'name');
    assert.equal(name.required, true);
    assert.equal(name.invalid, true);
    assert.ok(name.validationMessage.length > 0);
    assert.equal(name.label, 'Full name');
    assert.ok(name.bounds.width > 0 && name.bounds.height > 0);
    const consent = state.elements.find(e => e.name === 'consent');
    assert.equal(consent.checked, false);
    assert.equal(consent.role, 'checkbox');
    assert.equal(state.forms.length, 1);
    assert.ok(state.forms[0].invalid.includes('name'));
    assert.equal(state.forms[0].method, 'post');
    const submit = state.elements.find(e => e.id === 'submit');
    assert.equal(submit.role, 'button');
    assert.equal(submit.disabled, false);
  });

  it('truncates text and reports it', async () => {
    await page.goto(`${fx.url}/content`);
    const state = await collect({ maxText: 100 });
    assert.equal(state.text.length, 100);
    assert.equal(state.textTruncated, true);
    assert.equal(state.title, 'Local article fixture');
  });

  it('skips hidden elements', async () => {
    await page.goto(`${fx.url}/forms/basic`);
    await page.evaluate(() => { document.getElementById('email').style.display = 'none'; });
    const state = await collect();
    assert.equal(state.elements.some(e => e.name === 'email'), false);
    assert.equal(state.elements.some(e => e.name === 'csrf'), false, 'hidden inputs excluded');
  });
});
