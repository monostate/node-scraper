import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../browser-session.js';
import browserPool from '../browser-pool.js';
import { startFixtureServer } from './fixtures/server.mjs';

let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const skip = !chromeAvailable && 'Puppeteer not installed';
const TIMEOUT = 60000;

describe('pooled Chrome session isolation', { timeout: TIMEOUT, skip }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); browserPool.reopen(); await fx.close(); });

  it('a later session cannot read cookies or storage left by an earlier one', async () => {
    const a = await createSession({ mode: 'chrome' });
    await a.goto(`${fx.url}/interaction`);
    await a.evaluate(() => { document.cookie = 'candidate=A; Path=/'; localStorage.setItem('k', 'A'); sessionStorage.setItem('s', 'A'); });
    assert.equal(a.getBackend(), 'chrome');
    await a.close();

    const b = await createSession({ mode: 'chrome' });
    await b.goto(`${fx.url}/interaction`);
    const seen = await b.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('k'), session: sessionStorage.getItem('s') }));
    await b.close();
    assert.doesNotMatch(seen.cookie, /candidate=A/);
    assert.equal(seen.local, null);
    assert.equal(seen.session, null);
  });

  it('concurrent sessions only see their own state', async () => {
    const [x, y] = await Promise.all([createSession({ mode: 'chrome' }), createSession({ mode: 'chrome' })]);
    await Promise.all([x.goto(`${fx.url}/interaction`), y.goto(`${fx.url}/interaction`)]);
    await x.evaluate(() => { document.cookie = 'who=X; Path=/'; localStorage.setItem('who', 'X'); });
    await y.evaluate(() => { document.cookie = 'who=Y; Path=/'; localStorage.setItem('who', 'Y'); });
    const sx = await x.evaluate(() => ({ c: document.cookie, l: localStorage.getItem('who') }));
    const sy = await y.evaluate(() => ({ c: document.cookie, l: localStorage.getItem('who') }));
    await Promise.all([x.close(), y.close()]);
    assert.match(sx.c, /who=X/); assert.doesNotMatch(sx.c, /who=Y/); assert.equal(sx.l, 'X');
    assert.match(sy.c, /who=Y/); assert.doesNotMatch(sy.c, /who=X/); assert.equal(sy.l, 'Y');
  });

  it('isolate:false documents the shared default-context behaviour', async () => {
    const a = await createSession({ mode: 'chrome', isolate: false });
    await a.goto(`${fx.url}/interaction`);
    await a.evaluate(() => { document.cookie = 'shared=yes; Path=/'; });
    await a.close();
    const b = await createSession({ mode: 'chrome', isolate: false });
    await b.goto(`${fx.url}/interaction`);
    const cookie = await b.evaluate(() => document.cookie);
    await b.evaluate(() => { document.cookie = 'shared=; Max-Age=0; Path=/'; });
    await b.close();
    assert.match(cookie, /shared=yes/);
  });

  it('releases the pooled browser on close', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/interaction`);
    assert.equal(browserPool.getStats().busyCount, 1);
    await s.close();
    assert.equal(browserPool.getStats().busyCount, 0);
  });
});

describe('typed text redaction in history', { timeout: TIMEOUT, skip }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); browserPool.reopen(); await fx.close(); });

  it('does not record typed text by default', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/interaction`);
    await s.type('#cursor-input', 'hunter2');
    const history = JSON.stringify(s.getHistory());
    const entry = s.getHistory().find(h => h.type === 'type');
    await s.close();
    assert.doesNotMatch(history, /hunter2/);
    assert.equal(entry.textLength, 7);
  });

  it('records typed text when recordTypedText is true', async () => {
    const s = await createSession({ mode: 'chrome', recordTypedText: true });
    await s.goto(`${fx.url}/interaction`);
    await s.type('#cursor-input', 'hunter2');
    const entry = s.getHistory().find(h => h.type === 'type');
    await s.close();
    assert.equal(entry.text, 'hunter2');
  });

  it('redacts URL secrets in goto history', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/interaction?token=SECRET123`);
    const entry = s.getHistory().find(h => h.type === 'goto');
    await s.close();
    assert.doesNotMatch(entry.url, /SECRET123/);
    assert.match(entry.url, /token=%5Bredacted%5D/);
  });
});
