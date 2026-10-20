import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BNCASmartScraper } from '../index.js';
import { createSession } from '../browser-session.js';
import browserPool, { PoolAbortedError } from '../browser-pool.js';
import { Deadline, DeadlineError } from '../deadline.js';
import { startFixtureServer } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lpAvailable = fs.existsSync(path.join(here, '..', 'bin', 'lightpanda'));
let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('total deadline across scrape stages', { timeout: 60000 }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await fx.close(); });

  it('a slow direct fetch is cut at the deadline, not at the stage timeout', async () => {
    const s = new BNCASmartScraper({ timeout: 10000 });
    const t0 = Date.now();
    const r = await s.scrape(`${fx.url}/slow?ms=3000`, { deadline: 500, method: 'direct' });
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    assert.equal(r.success, false);
    assert.equal(r.transportSuccess, false);
    assert.equal(r.errorType, 'timeout');
    assert.equal(r.contentStatus, 'navigation_error');
    assert.ok(r.trace.stages.at(-1).outcome === 'cancelled' || r.trace.stages.at(-1).outcome === 'error');
    await s.cleanup();
  });

  it('later stages receive only the remaining budget', async () => {
    const s = new BNCASmartScraper({ timeout: 10000 });
    let seenRemaining = null;
    s.tryDirectFetch = async () => { await sleep(400); return { success: true, transportSuccess: true, needsBrowser: true, html: '<div id="root"></div>', httpStatus: 200 }; };
    s.tryLightpanda = async (url, config) => {
      seenRemaining = config.deadline.remaining();
      return { success: true, transportSuccess: true, httpStatus: 200, html: '<p>' + 'ok '.repeat(60) + '</p>', content: '{}' };
    };
    const r = await s.scrape(`${fx.url}/content`, { deadline: 500 });
    assert.ok(seenRemaining !== null, 'lightpanda stage ran');
    assert.ok(seenRemaining <= 100, `remaining budget was ${seenRemaining}ms`);
    assert.equal(r.method, 'lightpanda');
    await s.cleanup();
  });

  it('a stage is skipped as cancelled once the budget is gone', async () => {
    const s = new BNCASmartScraper({ timeout: 10000 });
    s.tryDirectFetch = async () => { await sleep(300); return { success: false, transportSuccess: false, error: 'boom' }; };
    let lpCalled = false;
    s.tryLightpanda = async () => { lpCalled = true; return { success: true, transportSuccess: true, html: '<p>' + 'x '.repeat(60) + '</p>' }; };
    const r = await s.scrape(`${fx.url}/content`, { deadline: 200 });
    assert.equal(lpCalled, false, 'no stage starts after the deadline');
    assert.equal(r.errorType, 'timeout');
    assert.ok(r.trace.stages.some(st => st.outcome === 'cancelled'));
    await s.cleanup();
  });

  it('an external AbortSignal cancels and stops further requests', async () => {
    const s = new BNCASmartScraper({ timeout: 10000 });
    const ac = new AbortController();
    fx.reset();
    setTimeout(() => ac.abort(), 100);
    const r = await s.scrape(`${fx.url}/slow?ms=2000`, { signal: ac.signal, method: 'direct' });
    assert.equal(r.success, false);
    assert.equal(r.errorType, 'cancelled');
    await sleep(200);
    assert.equal(fx.requests.filter(q => q.path === '/slow').length, 1);
    assert.equal(fx.requests.filter(q => q.at > Date.now() - 150).length, 0, 'no requests after abort');
    await s.cleanup();
  });

  it('the Lightpanda stage bounds --wait-ms and --http-timeout by the remaining budget', { skip: !lpAvailable && 'LightPanda not installed' }, async () => {
    const s = new BNCASmartScraper({ timeout: 10000 });
    let args = null;
    const realSpawn = s._spawn.bind(s);
    s._spawn = (cmd, a, opts) => { args = a; return realSpawn(cmd, a, opts); };
    await s.scrape(`${fx.url}/content`, { method: 'lightpanda', deadline: 1000 });
    assert.ok(args, 'lightpanda spawned');
    const waitMs = Number(args[args.indexOf('--wait-ms') + 1]);
    const httpTimeout = Number(args[args.indexOf('--http-timeout') + 1]);
    assert.ok(waitMs <= 1000, `--wait-ms ${waitMs}`);
    assert.ok(httpTimeout <= 1000, `--http-timeout ${httpTimeout}`);
    await s.cleanup();
  });

  it('Deadline.from accepts the scrape options shape', () => {
    const d = Deadline.from({ totalMs: 10, signal: new AbortController().signal });
    assert.ok(d.remaining() <= 10);
    d.dispose();
  });
});

describe('deadline and abort in BrowserSession and the pool', { timeout: 60000, skip: !chromeAvailable && 'Puppeteer not installed' }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); browserPool.configure({ maxInstances: 3 }); await fx.close(); });

  it('a queued session acquisition rejects with PoolAbortedError when its signal aborts', async () => {
    browserPool.configure({ maxInstances: 1 });
    const holder = await createSession({ mode: 'chrome' });
    const ac = new AbortController();
    const p = createSession({ mode: 'chrome', signal: ac.signal });
    await sleep(100);
    assert.equal(browserPool.getStats().queueLength, 1);
    ac.abort();
    await assert.rejects(p, (e) => e instanceof PoolAbortedError && e.code === 'POOL_ABORTED');
    assert.equal(browserPool.getStats().queueLength, 0);
    await holder.close();
    browserPool.configure({ maxInstances: 3 });
  });

  it('a session deadline bounds navigation and makes later actions fail fast', async () => {
    const s = await createSession({ mode: 'chrome', deadline: 600 });
    const t0 = Date.now();
    await assert.rejects(() => s.goto(`${fx.url}/slow?ms=5000`), /timeout|deadline/i);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
    await sleep(50);
    await assert.rejects(() => s.goto(`${fx.url}/content`), (e) => e instanceof DeadlineError);
    await s.close();
  });
});
