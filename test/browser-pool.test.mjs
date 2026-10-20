import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import browserPool, {
  BrowserPool, buildLaunchArgs,
  PoolClosedError, PoolQueueFullError, PoolAcquireTimeoutError, PoolAbortedError,
} from '../browser-pool.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A Browser-like stub: connected until close()/crash(). */
function fakeBrowser(id) {
  const em = new EventEmitter();
  let connected = true;
  return Object.assign(em, {
    id,
    isConnected: () => connected,
    close: async () => { connected = false; em.emit('disconnected'); },
    crash: () => { connected = false; em.emit('disconnected'); },
    newPage: async () => ({}),
  });
}

function makePool(opts = {}, { launchDelay = 25, launchFail = false } = {}) {
  const pool = new BrowserPool({ maxInstances: 3, idleTimeout: 60000, acquireTimeout: 5000, ...opts });
  let counter = 0;
  pool._launch = async () => {
    await sleep(launchDelay);
    if (launchFail) throw new Error('launch boom');
    return fakeBrowser(++counter);
  };
  return pool;
}

describe('BrowserPool allocation', () => {
  let pool;
  afterEach(async () => { await pool?.closeAll(); });

  it('never exceeds maxInstances under concurrent acquisition', async () => {
    pool = makePool();
    const p = [pool.getBrowser(), pool.getBrowser(), pool.getBrowser(), pool.getBrowser()];
    await sleep(120);
    const stats = pool.getStats();
    assert.equal(stats.poolSize, 3);
    assert.equal(stats.pending, 0);
    assert.equal(stats.queueLength, 1, 'fourth caller waits');
    const [a] = await Promise.all(p.slice(0, 3));
    pool.releaseBrowser(a);
    const d = await p[3];
    assert.equal(d, a, 'fourth caller receives the released browser');
    assert.equal(pool.getStats().poolSize, 3);
  });

  it('counts pending launches toward the limit', async () => {
    pool = makePool({}, { launchDelay: 80 });
    const first = pool.getBrowser();
    await sleep(10);
    assert.equal(pool.getStats().pending, 1);
    const more = [pool.getBrowser(), pool.getBrowser(), pool.getBrowser()];
    await sleep(10);
    assert.equal(pool.getStats().pending, 3);
    assert.equal(pool.getStats().queueLength, 1);
    await Promise.all([first, ...more.slice(0, 2)]);
    assert.equal(pool.getStats().poolSize, 3);
    more[2].catch(() => {}); // still queued; closeAll() in afterEach rejects it
  });

  it('releases the reservation when a launch fails and can launch again later', async () => {
    pool = makePool({}, { launchFail: true });
    await assert.rejects(pool.getBrowser(), /launch boom/);
    assert.equal(pool.getStats().pending, 0);
    assert.equal(pool.getStats().failed, 1);
    let n = 0;
    pool._launch = async () => fakeBrowser(++n);
    const b = await pool.getBrowser();
    assert.equal(b.id, 1);
  });

  it('reuses idle browsers before launching', async () => {
    pool = makePool();
    const a = await pool.getBrowser();
    pool.releaseBrowser(a);
    const b = await pool.getBrowser();
    assert.equal(a, b);
    assert.equal(pool.getStats().reused, 1);
    assert.equal(pool.getStats().created, 1);
  });
});

describe('BrowserPool queue', () => {
  let pool;
  afterEach(async () => { await pool?.closeAll(); });

  async function fillPool(p) {
    const held = await Promise.all([p.getBrowser(), p.getBrowser(), p.getBrowser()]);
    return held;
  }

  it('times out a queued acquisition', async () => {
    pool = makePool();
    await fillPool(pool);
    await assert.rejects(pool.getBrowser({ timeout: 50 }), (e) => e instanceof PoolAcquireTimeoutError && e.code === 'POOL_ACQUIRE_TIMEOUT');
    assert.equal(pool.getStats().queueLength, 0);
  });

  it('aborts a queued acquisition via AbortSignal', async () => {
    pool = makePool();
    await fillPool(pool);
    const ac = new AbortController();
    const p = pool.getBrowser({ signal: ac.signal });
    await sleep(10);
    ac.abort();
    await assert.rejects(p, (e) => e instanceof PoolAbortedError && e.code === 'POOL_ABORTED');
    assert.equal(pool.getStats().queueLength, 0);
  });

  it('rejects when the queue is full', async () => {
    pool = makePool({ maxQueue: 1 });
    await fillPool(pool);
    const first = pool.getBrowser({ timeout: 2000 });
    await assert.rejects(pool.getBrowser(), (e) => e instanceof PoolQueueFullError && e.code === 'POOL_QUEUE_FULL');
    first.catch(() => {});
  });

  it('closeAll() rejects queued callers, closes browsers, and the pool stays usable', async () => {
    pool = makePool();
    const held = await fillPool(pool);
    const q1 = pool.getBrowser();
    const q2 = pool.getBrowser();
    const t0 = Date.now();
    await pool.closeAll();
    await assert.rejects(q1, (e) => e instanceof PoolClosedError && e.code === 'POOL_CLOSED');
    await assert.rejects(q2, PoolClosedError);
    assert.ok(Date.now() - t0 < 500);
    assert.ok(held.every(b => !b.isConnected()), 'all browsers closed');
    assert.equal(pool.getStats().poolSize, 0);
    const b = await pool.getBrowser(); // drain is not permanent
    assert.ok(b && b.isConnected());
  });

  it('shutdown() refuses later acquisitions until reopen()', async () => {
    pool = makePool();
    await fillPool(pool);
    const q = pool.getBrowser();
    await pool.shutdown();
    await assert.rejects(q, PoolClosedError);
    await assert.rejects(pool.getBrowser(), PoolClosedError);
    pool.reopen();
    const b = await pool.getBrowser();
    assert.ok(b);
  });

  it('a crashed busy browser frees capacity for a queued caller', async () => {
    pool = makePool();
    const held = await fillPool(pool);
    const waiting = pool.getBrowser({ timeout: 2000 });
    await sleep(10);
    held[0].crash();
    const fresh = await waiting;
    assert.notEqual(fresh, held[0]);
    assert.equal(fresh.isConnected(), true);
    assert.equal(pool.getStats().poolSize, 3);
  });

  it('emits acquire/queued/launch/release/crash events', async () => {
    pool = makePool();
    const seen = [];
    for (const ev of ['launch', 'acquire', 'queued', 'release', 'crash']) pool.on(ev, () => seen.push(ev));
    const held = await fillPool(pool);
    const q = pool.getBrowser();
    await sleep(10);
    pool.releaseBrowser(held[1]);
    await q;
    held[2].crash();
    await sleep(10);
    for (const ev of ['launch', 'acquire', 'queued', 'release', 'crash']) assert.ok(seen.includes(ev), `missing event ${ev}`);
  });
});

describe('buildLaunchArgs and defaults', () => {
  it('keeps sandbox and web security on by default', () => {
    const args = buildLaunchArgs();
    assert.ok(!args.includes('--no-sandbox'));
    assert.ok(!args.includes('--disable-setuid-sandbox'));
    assert.ok(!args.includes('--disable-web-security'));
    assert.ok(args.includes('--disable-dev-shm-usage'));
  });

  it('adds insecure flags only when asked', () => {
    const args = buildLaunchArgs({ noSandbox: true, disableWebSecurity: true, extraArgs: ['--lang=en'] });
    assert.ok(args.includes('--no-sandbox') && args.includes('--disable-setuid-sandbox'));
    assert.ok(args.includes('--disable-web-security'));
    assert.ok(args.includes('--lang=en'));
  });

  it('legacy positional constructor and configure() still work', () => {
    const p = new BrowserPool(2, 1234);
    assert.equal(p.maxInstances, 2);
    assert.equal(p.idleTimeout, 1234);
    p.configure({ maxInstances: 5, launch: { noSandbox: true } });
    assert.equal(p.maxInstances, 5);
    assert.equal(p.launch.noSandbox, true);
  });

  it('exports a default singleton with the documented stats shape', () => {
    const stats = browserPool.getStats();
    for (const k of ['created', 'reused', 'queued', 'cleaned', 'failed', 'poolSize', 'busyCount', 'idleCount', 'queueLength', 'pending', 'maxInstances']) {
      assert.ok(k in stats, `stats.${k}`);
    }
  });
});
