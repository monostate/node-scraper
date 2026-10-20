// Regression tests for the findings of the v3 whole-branch review.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BNCASmartScraper } from '../index.js';
import { BrowserSession, createSession } from '../browser-session.js';
import browserPool, { BrowserPool, buildLaunchArgs, PoolAcquireTimeoutError } from '../browser-pool.js';
import { Deadline, DeadlineError } from '../deadline.js';
import { stopLightPandaServer } from '../lightpanda-server.js';
import { startFixtureServer } from './fixtures/server.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const lpAvailable = fs.existsSync(path.join(here, '..', 'bin', 'lightpanda'));
let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const needChrome = !chromeAvailable && 'Puppeteer not installed';

function fakeBrowser(id) {
  const em = new EventEmitter();
  let connected = true;
  return Object.assign(em, {
    id,
    isConnected: () => connected,
    close: async () => { connected = false; em.emit('disconnected'); },
    newPage: async () => ({}),
  });
}

describe('Critical 1: deadlines never become "no timeout"', () => {
  it('_timeout() throws DeadlineError once the session deadline has expired and never returns 0', async () => {
    const s = new BrowserSession({ mode: 'chrome', deadline: 30 });
    const t = s._timeout(5000);
    assert.ok(t >= 1 && t <= 30, `got ${t}`);
    await sleep(50);
    assert.throws(() => s._timeout(5000), (e) => e instanceof DeadlineError);
  });

  it('tryPuppeteer returns a cancelled result without touching the pool when the budget is already spent', async () => {
    const scraper = new BNCASmartScraper();
    const d = Deadline.from(1);
    await sleep(10);
    let acquired = false;
    const orig = browserPool.getBrowser;
    browserPool.getBrowser = async (...a) => { acquired = true; return orig.apply(browserPool, a); };
    try {
      const r = await scraper.tryPuppeteer('http://127.0.0.1:1/', { timeout: 5000, deadline: d, signal: d.signal, userAgent: 'x' });
      assert.equal(r.cancelled, true);
      assert.equal(r.errorType, 'timeout');
      assert.equal(acquired, false, 'no browser acquired after expiry');
    } finally {
      browserPool.getBrowser = orig;
      d.dispose();
    }
  });
});

describe('Critical 2: scraper-level sandbox options reach the pool', () => {
  it('new BNCASmartScraper({ noSandbox, disableWebSecurity }) configures the shared pool launch', () => {
    const before = { ...browserPool.launch };
    try {
      new BNCASmartScraper({ noSandbox: true, disableWebSecurity: true });
      assert.equal(browserPool.launch.noSandbox, true);
      assert.equal(browserPool.launch.disableWebSecurity, true);
      const args = buildLaunchArgs(browserPool.launch);
      assert.ok(args.includes('--no-sandbox') && args.includes('--disable-web-security'));
    } finally {
      browserPool.configure({ launch: before });
    }
  });

  it('per-call scrape options also apply', async () => {
    const before = { ...browserPool.launch };
    const scraper = new BNCASmartScraper();
    scraper.tryDirectFetch = async () => ({ success: true, transportSuccess: true, html: '<p>' + 'x '.repeat(60) + '</p>', httpStatus: 200 });
    try {
      await scraper.scrape('https://x.test', { noSandbox: true });
      assert.equal(browserPool.launch.noSandbox, true);
    } finally {
      browserPool.configure({ launch: before });
    }
  });
});

describe('Important 1 & 2: pool cleanup race and launch-flag mismatch', () => {
  it('cleanup() never hands out a browser it is about to close', async () => {
    const pool = new BrowserPool({ maxInstances: 3, idleTimeout: 10 });
    let n = 0;
    pool._launch = async () => {
      const b = fakeBrowser(++n);
      const close = b.close;
      b.close = async () => { await sleep(60); await close(); };
      return b;
    };
    const a = await pool.getBrowser();
    const b = await pool.getBrowser();
    pool.releaseBrowser(a);
    pool.releaseBrowser(b);
    for (const e of pool.pool) e.lastUsed = Date.now() - 1000;
    if (pool.cleanupTimer) { clearTimeout(pool.cleanupTimer); pool.cleanupTimer = null; }
    const cleaning = pool.cleanup();
    await sleep(10); // first close in flight
    const c = await pool.getBrowser();
    await cleaning;
    assert.equal(c.isConnected(), true, 'a browser handed out during cleanup must stay open');
    await pool.shutdown();
  });

  it('configure() emits a warning when security flags change while browsers exist', async () => {
    const pool = new BrowserPool({ maxInstances: 2 });
    let n = 0;
    pool._launch = async () => fakeBrowser(++n);
    const warns = [];
    pool.on('warn', (w) => warns.push(w));
    const b = await pool.getBrowser();
    pool.releaseBrowser(b);
    pool.configure({ launch: { disableWebSecurity: true } });
    assert.equal(warns.length, 1);
    assert.match(warns[0].message, /disableWebSecurity/);
    pool.configure({ launch: { disableWebSecurity: true } });
    assert.equal(warns.length, 1, 'unchanged flags do not warn again');
    await pool.shutdown();
  });
});

describe('Important 3: CLI screenshot paths honour the sandbox default', () => {
  function stubSpawn(calls) {
    return (cmd, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.emit('exit', 1, null), 5);
      return child;
    };
  }

  it('keeps the sandbox on by default and adds --no-sandbox only when asked', async () => {
    const before = { ...browserPool.launch };
    const envBefore = process.env.BNCA_CHROME_NO_SANDBOX;
    delete process.env.BNCA_CHROME_NO_SANDBOX; // containers set this; the assertion is about the library default
    browserPool.configure({ launch: { noSandbox: false } });
    try {
      const calls = [];
      const scraper = new BNCASmartScraper();
      scraper.findChromePath = async () => '/bin/true';
      scraper._spawn = stubSpawn(calls);
      await scraper.screenshot('http://127.0.0.1:1/');
      await scraper.quickshot('http://127.0.0.1:1/');
      assert.ok(calls.length >= 2);
      assert.ok(calls.every(a => !a.includes('--no-sandbox') && !a.includes('--disable-setuid-sandbox')), JSON.stringify(calls[0]));

      const calls2 = [];
      const s2 = new BNCASmartScraper({ noSandbox: true });
      s2.findChromePath = async () => '/bin/true';
      s2._spawn = stubSpawn(calls2);
      await s2.screenshot('http://127.0.0.1:1/');
      assert.ok(calls2[0].includes('--no-sandbox') && calls2[0].includes('--disable-setuid-sandbox'));
    } finally {
      if (envBefore !== undefined) process.env.BNCA_CHROME_NO_SANDBOX = envBefore;
      browserPool.configure({ launch: before });
    }
  });
});

describe('Important 7 & re-graded: fallback safety', { timeout: 60000 }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); await stopLightPandaServer(); await fx.close(); });

  it('_shouldFallback only applies in auto mode', async () => {
    const cu = new BrowserSession({ mode: 'computer-use', provider: {} });
    cu.activeBackend = 'computer-use';
    assert.equal(await cu._shouldFallback(new Error('Protocol error: x')), false);
    const headless = new BrowserSession({ mode: 'headless' });
    headless.activeBackend = 'lightpanda';
    assert.equal(await headless._shouldFallback(new Error('Protocol error: x')), false);
    const auto = new BrowserSession({ mode: 'auto' });
    auto.activeBackend = 'lightpanda';
    assert.equal(await auto._shouldFallback(new Error('Protocol error: x')), true);
  });

  it('a failed engine fallback leaves the session cleanly disconnected', { skip: needChrome || (!lpAvailable && 'LightPanda not installed') }, async () => {
    const s = await createSession({ mode: 'auto', timeout: 15000 });
    assert.equal(s.getBackend(), 'lightpanda');
    await s.goto(`${fx.url}/content`);
    const orig = browserPool.getBrowser;
    browserPool.getBrowser = async () => { throw new PoolAcquireTimeoutError('pool full'); };
    try {
      await assert.rejects(() => s._fallbackToChrome('test'), (e) => e instanceof PoolAcquireTimeoutError);
    } finally {
      browserPool.getBrowser = orig;
    }
    assert.equal(s._connected, false);
    assert.equal(s.page, null);
    assert.equal(s.activeBackend, null);
    await assert.rejects(() => s.goto(`${fx.url}/content`), /not connected|fallback failed/i);
    await s.close();
  });

  it('single-character key presses and error strings are redacted in history', { skip: needChrome }, async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/password`);
    await s.click('#pw', { waitForNavigation: false });
    for (const ch of 'hunter2') await s.pressKey(ch);
    await s.pressKey('Enter');
    const h = s.getHistory();
    assert.doesNotMatch(JSON.stringify(h), /"key":"h"|"key":"u"|"key":"2"/);
    assert.ok(h.some(e => e.type === 'pressKey' && e.key === 'Enter'));
    assert.ok(h.some(e => e.type === 'pressKey' && e.key === '[char]'));
    const entry = s._logAction('click', { selector: '#x', outcome: 'uncertain', uncertainReason: 'navigation_error:net::ERR at https://h/?token=T2', error: 'password=p4ss' });
    assert.doesNotMatch(entry.uncertainReason, /T2/);
    assert.doesNotMatch(entry.error, /p4ss/);
    await s.close();
  });
});
