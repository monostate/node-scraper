import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, ACTION_KIND } from '../browser-session.js';
import browserPool from '../browser-pool.js';
import { stopLightPandaServer } from '../lightpanda-server.js';
import { startFixtureServer } from './fixtures/server.mjs';

let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const skip = !chromeAvailable && 'Puppeteer not installed';
const here = path.dirname(fileURLToPath(import.meta.url));
const lpAvailable = fs.existsSync(path.join(here, '..', 'bin', 'lightpanda'));
const TIMEOUT = 60000;

async function fillBasic(s) {
  await s.type('#name', 'Fallback Tester');
  await s.type('#email', 'qa@example.invalid');
  await s.select('#country', 'UK');
  await s.type('#cover', 'Controlled fixture only');
  await s.click('#consent', { waitForNavigation: false });
}

describe('action classification and uncertain outcomes', { timeout: TIMEOUT, skip }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); browserPool.reopen(); await fx.close(); });

  it('exports ACTION_KIND', () => {
    assert.equal(ACTION_KIND.SAFE, 'safe');
    assert.equal(ACTION_KIND.MUTATING, 'mutating');
  });

  it('a submit whose response is dropped is reported as uncertain and is never replayed by the library', async () => {
    fx.reset();
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/forms/basic`);
    await fillBasic(s);
    await s.evaluate(() => { document.getElementById('application').action = '/submit-drop'; });
    // Requests as the browser's request layer sees them (DevTools Network domain).
    const issued = [];
    s.page.on('request', (r) => { if (r.url().endsWith('/submit-drop')) issued.push(r.method()); });
    const result = await s.click('#submit');
    const history = s.getHistory();
    await s.close();
    assert.equal(result.outcome, 'uncertain', JSON.stringify(result));
    assert.equal(result.success, false);
    assert.match(result.uncertainReason, /navigation|response|connection/i);
    assert.deepEqual(issued, ['POST'], 'exactly one request issued by the browser request layer');
    assert.equal(history.filter(h => h.type === 'click' && h.selector === '#submit').length, 1, 'library dispatched the click once');
    assert.equal(history.some(h => h.type === 'fallback'), false, 'no engine fallback/replay for a mutating action');
    // The server may see a second identical attempt: Chromium's HTTP transport
    // re-sends once when the socket died before any response headers arrived.
    // That is below the request layer and outside the library's control.
    assert.ok(fx.attempts.length >= 1 && fx.attempts.length <= 2, JSON.stringify(fx.attempts));
    assert.ok(fx.attempts.every(a => a.dropped));
  });

  it('a normal click reports outcome ok', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/forms/basic`);
    const r = await s.click('#consent', { waitForNavigation: false });
    await s.close();
    assert.equal(r.outcome, 'ok');
    assert.equal(r.success, true);
  });
});

describe('checkpoint / restore', { timeout: TIMEOUT, skip }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); browserPool.reopen(); await fx.close(); });

  it('captures cookies (incl. HttpOnly via CDP), storage and non-sensitive form values', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/forms/basic`);
    await s.type('#name', 'Checkpoint Person');
    await s.evaluate(() => { localStorage.setItem('k', 'v'); sessionStorage.setItem('sk', 'sv'); });
    const cp = await s.checkpoint();
    await s.close();
    assert.equal(cp.url, `${fx.url}/forms/basic`);
    assert.ok(cp.cookies.some(c => c.name === 'qa-session' && c.value === 'local-audit'));
    assert.deepEqual(cp.localStorage, { k: 'v' });
    assert.deepEqual(cp.sessionStorage, { sk: 'sv' });
    assert.ok(cp.formValues.some(f => f.selector === '#name' && f.value === 'Checkpoint Person'));
    assert.ok(cp.captured.includes('cookies') && cp.captured.includes('formValues'));
    assert.ok(cp.notTransferable.includes('indexedDB'));
    assert.ok(cp.notTransferable.includes('serviceWorkers'));
  });

  it('restores into a fresh session', async () => {
    const a = await createSession({ mode: 'chrome' });
    await a.goto(`${fx.url}/forms/basic`);
    await a.type('#name', 'Restored Person');
    await a.evaluate(() => { localStorage.setItem('k', 'v2'); });
    const cp = await a.checkpoint();
    await a.close();

    const b = await createSession({ mode: 'chrome' });
    await b.goto('about:blank');
    const r = await b.restore(cp);
    assert.ok(r.restored.includes('cookies'), JSON.stringify(r));
    assert.ok(r.restored.includes('localStorage'));
    assert.ok(r.restored.includes('formValues'));
    assert.equal(await b.evaluate(() => document.querySelector('#name').value), 'Restored Person');
    assert.equal(await b.evaluate(() => localStorage.getItem('k')), 'v2');
    await b.goto(`${fx.url}/cookie-check`);
    const body = await b.evaluate(() => document.body.textContent);
    await b.close();
    assert.match(body, /qa-session=local-audit/);
  });

  it('never throws for cookies the browser rejects; reports them as skipped', async () => {
    const b = await createSession({ mode: 'chrome' });
    await b.goto(`${fx.url}/forms/basic`);
    const r = await b.restore({
      url: `${fx.url}/forms/basic`,
      cookies: [
        { name: 'ok', value: '1', domain: '127.0.0.1', path: '/' },
        { name: 'bad', value: '1', domain: 'definitely-not-this-host.invalid', path: '/' , secure: true },
      ],
      localStorage: {}, sessionStorage: {}, formValues: [],
    });
    await b.close();
    assert.ok(Array.isArray(r.skipped));
    assert.ok(r.restored.includes('cookies') || r.skipped.some(x => x.item.startsWith('cookie:')));
  });

  it('does not capture password or otp values', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/password`);
    await s.type('#user', 'bob');
    await s.type('#pw', 'hunter2');
    await s.type('#otp', '123456');
    const cp = await s.checkpoint();
    await s.close();
    const json = JSON.stringify(cp);
    assert.doesNotMatch(json, /hunter2/);
    assert.doesNotMatch(json, /123456/);
    assert.ok(cp.formValues.some(f => f.selector === '#user' && f.value === 'bob'));
    assert.ok(!cp.formValues.some(f => f.selector === '#pw' || f.selector === '#otp'));
  });
});

describe('LightPanda → Chrome fallback carries state', { timeout: TIMEOUT, skip: skip || (!lpAvailable && 'LightPanda not installed') }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); browserPool.reopen(); await stopLightPandaServer(); await fx.close(); });

  it('screenshot() on an LP session falls back and preserves cookie + typed form value', async () => {
    const s = await createSession({ mode: 'auto', timeout: 15000 });
    assert.equal(s.getBackend(), 'lightpanda');
    await s.goto(`${fx.url}/forms/basic`);
    await s.type('#name', 'Carried Over');
    const shot = await s.screenshot({ fullPage: false });
    assert.equal(s.getBackend(), 'chrome');
    assert.match(shot.screenshot, /^data:image\/png;base64,/);
    assert.equal(await s.evaluate(() => document.querySelector('#name').value), 'Carried Over');
    const fb = s.getHistory().find(h => h.type === 'fallback');
    assert.ok(fb, 'fallback recorded in history');
    assert.ok(Array.isArray(fb.restored) && fb.restored.includes('cookies'), JSON.stringify(fb));
    assert.ok(Array.isArray(fb.notTransferable));
    await s.goto(`${fx.url}/cookie-check`);
    const body = await s.evaluate(() => document.body.textContent);
    await s.close();
    assert.match(body, /qa-session=local-audit/);
  });
});

// Audit item 9 reproduced a cookie missing from a form POST on Lightpanda v0.2.5.
// This pins the behaviour of the 1.0.1 build we now ship: the cookie set by the
// page response travels on the submit, and the CSRF field reaches the server.
describe('Lightpanda 1.0.1 stateful forms (fixture)', { timeout: TIMEOUT, skip: !lpAvailable && 'LightPanda not installed' }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await stopLightPandaServer(); await fx.close(); });

  it('sends the session cookie and CSRF token on a form POST without leaving Lightpanda', async () => {
    const s = await createSession({ mode: 'headless', timeout: 15000 });
    assert.equal(s.getBackend(), 'lightpanda');
    await s.goto(`${fx.url}/forms/basic`);
    assert.equal(await s.evaluate(() => document.cookie), 'qa-session=local-audit');
    await fillBasic(s);
    const r = await s.click('#submit', { waitForNavigation: true });
    assert.equal(r.outcome, 'ok');
    assert.equal(s.getBackend(), 'lightpanda');
    await s.close();
    assert.equal(fx.attempts.length, 1, 'exactly one POST reached the fixture');
    const post = fx.attempts[0];
    assert.equal(post.valid, true, JSON.stringify(post));
    assert.match(post.cookie, /qa-session=local-audit/);
    assert.equal(post.fields.csrf, 'local-audit-token');
    assert.equal(post.fields.name, 'Fallback Tester');
  });
});
