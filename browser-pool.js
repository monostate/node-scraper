/**
 * BrowserPool — bounded pool of headless Chrome instances.
 *
 * Guarantees:
 * - the configured maximum is never exceeded: capacity is reserved before a
 *   launch starts, and pending launches count toward the limit
 * - queued acquisitions are cancellable (timeout / AbortSignal), bounded
 *   (maxQueue) and are rejected on closeAll()
 * - a crashed browser frees its slot and a queued caller gets a new launch
 * - sandbox and web security stay ON unless explicitly disabled
 */
import { EventEmitter } from 'node:events';

class PoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
export class PoolClosedError extends PoolError {
  constructor(msg = 'browser pool is closed') { super('POOL_CLOSED', msg); }
}
export class PoolQueueFullError extends PoolError {
  constructor(msg = 'browser pool queue is full') { super('POOL_QUEUE_FULL', msg); }
}
export class PoolAcquireTimeoutError extends PoolError {
  constructor(msg = 'timed out waiting for a browser') { super('POOL_ACQUIRE_TIMEOUT', msg); }
}
export class PoolAbortedError extends PoolError {
  constructor(msg = 'browser acquisition aborted') { super('POOL_ABORTED', msg); }
}

const BASE_ARGS = Object.freeze([
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-features=VizDisplayCompositor,TranslateUI',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-component-update',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
]);

/**
 * Build Chrome launch args. Insecure flags are opt-in.
 */
export function buildLaunchArgs({ noSandbox = false, disableWebSecurity = false, extraArgs = [] } = {}) {
  const args = [...BASE_ARGS];
  if (noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (disableWebSecurity) args.push('--disable-web-security');
  return [...args, ...extraArgs];
}

const DEFAULT_LAUNCH = Object.freeze({
  headless: true,
  noSandbox: process.env.BNCA_CHROME_NO_SANDBOX === '1',
  disableWebSecurity: false,
  executablePath: process.env.BNCA_CHROME_PATH || undefined,
  extraArgs: [],
});

export class BrowserPool extends EventEmitter {
  /**
   * @param {number|object} [maxOrOpts=3] legacy positional max, or options
   * @param {number} [idleTimeout=5000] legacy positional idle timeout
   */
  constructor(maxOrOpts = 3, idleTimeout = 5000) {
    super();
    const opts = typeof maxOrOpts === 'object' && maxOrOpts !== null
      ? maxOrOpts
      : { maxInstances: maxOrOpts, idleTimeout };

    this.maxInstances = opts.maxInstances ?? 3;
    this.idleTimeout = opts.idleTimeout ?? 5000;
    this.maxQueue = opts.maxQueue ?? 100;
    this.acquireTimeout = opts.acquireTimeout ?? 30000;
    this.launch = { ...DEFAULT_LAUNCH, ...(opts.launch || {}) };

    this.pool = [];                 // [{ instance, created, lastUsed }]
    this.busyBrowsers = new Set();  // Set<instance>
    this.requestQueue = [];         // [{ resolve, reject, timer, signal, onAbort, enqueuedAt }]
    this.pending = 0;               // launches in flight
    this.closed = false;
    this.cleanupTimer = null;
    this.stats = { created: 0, reused: 0, queued: 0, cleaned: 0, failed: 0 };
  }

  /** Merge limits/launch options at runtime. */
  configure(partial = {}) {
    if (partial.maxInstances != null) this.maxInstances = partial.maxInstances;
    if (partial.idleTimeout != null) this.idleTimeout = partial.idleTimeout;
    if (partial.maxQueue != null) this.maxQueue = partial.maxQueue;
    if (partial.acquireTimeout != null) this.acquireTimeout = partial.acquireTimeout;
    if (partial.launch) this.launch = { ...this.launch, ...partial.launch };
    return this;
  }

  // ── Acquisition ───────────────────────────────────────────────

  /**
   * @param {{ timeout?: number, signal?: AbortSignal }} [opts]
   */
  async getBrowser({ timeout = this.acquireTimeout, signal } = {}) {
    if (this.closed) throw new PoolClosedError();
    if (signal?.aborted) throw new PoolAbortedError();

    const idle = this._idleEntry();
    if (idle) {
      this._markBusy(idle);
      this.stats.reused++;
      this.emit('acquire', { waitedMs: 0, reused: true });
      return idle.instance;
    }

    if (this._hasCapacity()) {
      const instance = await this._launchReserved();
      this.emit('acquire', { waitedMs: 0, reused: false });
      return instance;
    }

    if (this.requestQueue.length >= this.maxQueue) throw new PoolQueueFullError();
    this.stats.queued++;
    return this._enqueue({ timeout, signal });
  }

  releaseBrowser(browser) {
    if (!browser) return;
    this.busyBrowsers.delete(browser);
    const entry = this.pool.find(b => b.instance === browser);
    if (entry) entry.lastUsed = Date.now();
    this.emit('release');
    this.processQueue();
    this._scheduleCleanup();
  }

  // ── Internals ─────────────────────────────────────────────────

  _idleEntry() {
    return this.pool.find(b => !this.busyBrowsers.has(b.instance) && this._connected(b.instance));
  }

  _hasCapacity() {
    return this.pool.length + this.pending < this.maxInstances;
  }

  _markBusy(entry) {
    entry.lastUsed = Date.now();
    this.busyBrowsers.add(entry.instance);
  }

  _connected(instance) {
    try { return typeof instance.isConnected === 'function' ? instance.isConnected() : true; } catch { return false; }
  }

  /** Reserve a slot, launch, register. Releases the reservation on failure. */
  async _launchReserved() {
    this.pending++;
    try {
      const instance = await this._launch();
      const entry = { instance, created: Date.now(), lastUsed: Date.now() };
      this.pool.push(entry);
      this.busyBrowsers.add(instance);
      this.stats.created++;
      this._watch(entry);
      this.emit('launch');
      if (this.closed) {
        // closeAll() ran while we were launching: do not hand out a browser
        this.busyBrowsers.delete(instance);
        this._closeInstance(instance);
        this.pool = this.pool.filter(b => b !== entry);
        throw new PoolClosedError();
      }
      return instance;
    } catch (err) {
      if (!(err instanceof PoolClosedError)) this.stats.failed++;
      throw err;
    } finally {
      this.pending--;
      // capacity may have changed (success or failure): serve the queue
      queueMicrotask(() => this.processQueue());
    }
  }

  /** Test seam: launch one browser. */
  async _launch() {
    const puppeteer = await this.getPuppeteer();
    const { headless, noSandbox, disableWebSecurity, executablePath, extraArgs } = this.launch;
    try {
      return await puppeteer.launch({
        headless,
        executablePath,
        args: buildLaunchArgs({ noSandbox, disableWebSecurity, extraArgs }),
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (!noSandbox && /sandbox|SUID|namespace|running as root/i.test(msg)) {
        err.message = `${msg}\nChrome refused to start its sandbox. If this is a container, pass { launch: { noSandbox: true } } (or set BNCA_CHROME_NO_SANDBOX=1) explicitly.`;
      }
      throw err;
    }
  }

  _watch(entry) {
    entry.instance.on?.('disconnected', () => {
      if (!this.pool.includes(entry)) return;
      this.removeBrowser(entry);
      this.emit('crash', { created: entry.created });
      this.processQueue();
    });
  }

  async getPuppeteer() {
    try {
      const puppeteer = await import('puppeteer');
      return puppeteer.default || puppeteer;
    } catch {
      throw new Error('Puppeteer is not installed. Please install it to use Puppeteer-based scraping.');
    }
  }

  _enqueue({ timeout, signal }) {
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, timer: null, signal, onAbort: null, enqueuedAt: Date.now() };
      const remove = () => {
        const i = this.requestQueue.indexOf(request);
        if (i !== -1) this.requestQueue.splice(i, 1);
        if (request.timer) clearTimeout(request.timer);
        if (signal && request.onAbort) signal.removeEventListener('abort', request.onAbort);
      };
      request.settle = (fn, value) => { remove(); fn(value); };

      if (Number.isFinite(timeout) && timeout > 0) {
        request.timer = setTimeout(() => request.settle(reject, new PoolAcquireTimeoutError(`timed out after ${timeout}ms waiting for a browser`)), timeout);
      }
      if (signal) {
        request.onAbort = () => request.settle(reject, new PoolAbortedError());
        signal.addEventListener('abort', request.onAbort, { once: true });
      }
      this.requestQueue.push(request);
      this.emit('queued', { queueLength: this.requestQueue.length });
    });
  }

  /** Hand idle browsers to waiting callers, or launch for them when there is capacity. */
  processQueue() {
    if (this.closed) return;
    while (this.requestQueue.length > 0) {
      const idle = this._idleEntry();
      if (idle) {
        const request = this.requestQueue[0];
        this._markBusy(idle);
        this.stats.reused++;
        request.settle(request.resolve, idle.instance);
        this.emit('acquire', { waitedMs: Date.now() - request.enqueuedAt, reused: true });
        continue;
      }
      if (this._hasCapacity()) {
        const request = this.requestQueue.shift();
        if (request.timer) clearTimeout(request.timer);
        if (request.signal && request.onAbort) request.signal.removeEventListener('abort', request.onAbort);
        this._launchReserved().then(
          (instance) => {
            if (request.signal?.aborted) {
              this.releaseBrowser(instance);
              request.reject(new PoolAbortedError());
              return;
            }
            this.emit('acquire', { waitedMs: Date.now() - request.enqueuedAt, reused: false });
            request.resolve(instance);
          },
          (err) => request.reject(err),
        );
        continue;
      }
      return; // full: wait for a release or crash
    }
  }

  removeBrowser(browserObj) {
    const index = this.pool.findIndex(b => b === browserObj || b.instance === browserObj.instance);
    if (index !== -1) {
      const [entry] = this.pool.splice(index, 1);
      this.busyBrowsers.delete(entry.instance);
    }
  }

  async _closeInstance(instance) {
    try {
      if (this._connected(instance)) await instance.close();
    } catch (error) {
      const msg = String(error?.message || '');
      if (!/Protocol error|Target closed|Connection closed/.test(msg)) {
        console.warn('Error closing browser:', msg);
      }
    }
  }

  // ── Idle cleanup ──────────────────────────────────────────────

  _scheduleCleanup() {
    if (this.cleanupTimer || this.closed) return;
    this.cleanupTimer = setTimeout(() => this.cleanup(), this.idleTimeout);
    this.cleanupTimer.unref?.();
  }

  async cleanup() {
    this.cleanupTimer = null;
    if (this.closed) return;
    const now = Date.now();
    const minBrowsers = this.requestQueue.length > 0 ? 1 : 0;
    const toRemove = [];
    for (const browser of this.pool) {
      if (this.pool.length - toRemove.length <= minBrowsers) break;
      const isIdle = !this.busyBrowsers.has(browser.instance);
      if (isIdle && now - browser.lastUsed > this.idleTimeout) toRemove.push(browser);
    }
    for (const browser of toRemove) {
      this.removeBrowser(browser);
      await this._closeInstance(browser.instance);
      this.stats.cleaned++;
    }
    if (this.pool.length > 0) this._scheduleCleanup();
  }

  // ── Shutdown ──────────────────────────────────────────────────

  /** Reject waiters, close every browser, refuse new acquisitions until reopen(). */
  async closeAll() {
    this.closed = true;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const waiters = this.requestQueue.splice(0);
    for (const request of waiters) request.settle(request.reject, new PoolClosedError());

    const entries = this.pool.splice(0);
    this.busyBrowsers.clear();
    await Promise.all(entries.map(e => this._closeInstance(e.instance)));
    this.emit('closed');
  }

  reopen() {
    this.closed = false;
    return this;
  }

  getStats() {
    return {
      ...this.stats,
      poolSize: this.pool.length,
      busyCount: this.busyBrowsers.size,
      idleCount: this.pool.length - this.busyBrowsers.size,
      queueLength: this.requestQueue.length,
      pending: this.pending,
      maxInstances: this.maxInstances,
    };
  }
}

// Global browser pool instance
const browserPool = new BrowserPool();

// Best-effort cleanup when the host process goes away. No SIGTERM/SIGINT
// listeners: a library must not swallow the host's termination signals.
process.once('beforeExit', () => { browserPool.closeAll().catch(() => {}); });

export default browserPool;
