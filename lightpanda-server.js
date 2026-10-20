/**
 * LightPandaServer — manages one `lightpanda serve` CDP process.
 *
 * - start() is idempotent and concurrency-safe (one in-flight promise)
 * - readiness: stderr "server running" (1.0.x) / "Listening on" (older),
 *   or a successful GET /json/version; every timer is cleared on settle
 * - stop() awaits process exit with SIGTERM→SIGKILL escalation
 * - a crash after readiness clears state so the next start() respawns
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { terminate, findFreePort } from './process-util.js';

const READY_RE = /server running|Listening on/;

class LightPandaServer {
  /**
   * @param {string} [binaryPath]
   * @param {{ startTimeoutMs?: number, maxConnections?: number, host?: string }} [opts]
   */
  constructor(binaryPath, { startTimeoutMs = 10000, maxConnections = 16, host = '127.0.0.1' } = {}) {
    this.binaryPath = binaryPath || this._findBinary();
    this.startTimeoutMs = startTimeoutMs;
    this.maxConnections = maxConnections;
    this.host = host;
    this.process = null;
    this.port = null;
    this.ready = false;
    this.stderrTail = '';
    this._starting = null;
    this._stopping = null;
  }

  /**
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<string>} ws endpoint
   */
  async start({ signal } = {}) {
    if (this.process && this.ready) return this.getEndpoint();
    if (this._starting) return this._starting;
    this._starting = this._start(signal).finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start(signal) {
    if (signal?.aborted) throw new Error('LightPanda start aborted');
    if (this._stopping) await this._stopping;

    const port = await findFreePort();
    const args = [
      'serve',
      '--host', this.host,
      '--port', String(port),
      '--cdp-max-connections', String(this.maxConnections),
    ];

    let proc;
    try {
      proc = spawn(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`Failed to start LightPanda: ${err.message}`);
    }
    this.process = proc;
    this.port = port;
    this.ready = false;

    let stderr = '';
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t; };
    let pollTimer = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const clearAll = () => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearAll();
        fn(value);
      };
      const onReady = () => {
        if (settled || this.process !== proc) return;
        this.ready = true;
        settle(resolve, this.getEndpoint());
      };
      const fail = (message, { kill = true } = {}) => {
        if (settled) return;
        if (this.process === proc) this._clear();
        // Settle first so the caller sees the real reason (not the SIGTERM exit
        // we are about to cause); the kill is tracked so a later start() waits.
        settle(reject, new Error(message));
        if (kill) {
          const stopping = terminate(proc, { graceMs: 1000 })
            .catch(() => {})
            .finally(() => { if (this._stopping === stopping) this._stopping = null; });
          this._stopping = stopping;
        }
      };
      const onAbort = () => fail('LightPanda start aborted');
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout.on('data', () => {});
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
        this.stderrTail = stderr;
        if (!this.ready && READY_RE.test(stderr)) onReady();
      });

      proc.on('error', (err) => {
        fail(`Failed to start LightPanda: ${err.message}`, { kill: false });
      });

      proc.on('exit', (code, sig) => {
        const wasReady = this.ready;
        if (this.process === proc) this._clear();
        if (!wasReady) {
          fail(`LightPanda exited with code ${code}${sig ? ` (${sig})` : ''} before becoming ready: ${stderr.slice(-500)}`, { kill: false });
        }
      });

      // Fallback readiness probe in case the log line changes again.
      later(() => {
        pollTimer = setInterval(async () => {
          if (settled) return;
          try {
            const res = await fetch(`http://${this.host}:${port}/json/version`, { signal: AbortSignal.timeout(500) });
            if (res.ok) onReady();
          } catch { /* not up yet */ }
        }, 200);
      }, 300);

      later(() => fail(`LightPanda failed to start within ${this.startTimeoutMs}ms. stderr: ${stderr.slice(-500)}`), this.startTimeoutMs);
    });
  }

  getEndpoint() {
    return `ws://${this.host}:${this.port}`;
  }

  isRunning() {
    return this.ready && this.process !== null;
  }

  /** Version reported by the running server (null when not running). */
  async version() {
    if (!this.isRunning()) return null;
    try {
      const res = await fetch(`http://${this.host}:${this.port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const data = await res.json();
      return data['Lightpanda-Version'] || null;
    } catch {
      return null;
    }
  }

  /**
   * Stop the server and wait for the process to exit.
   * @param {{ graceMs?: number }} [opts]
   */
  async stop({ graceMs = 2000 } = {}) {
    if (this._stopping) return this._stopping;
    const proc = this.process;
    this._clear();
    if (!proc) return;
    this._stopping = terminate(proc, { graceMs })
      .catch(() => {})
      .finally(() => { this._stopping = null; });
    return this._stopping;
  }

  _clear() {
    this.process = null;
    this.ready = false;
    this.port = null;
  }

  _findBinary() {
    const candidates = [
      ...(process.env.LIGHTPANDA_PATH ? [process.env.LIGHTPANDA_PATH] : []),
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'lightpanda'),
      '/usr/local/bin/lightpanda',
      '/usr/bin/lightpanda',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return 'lightpanda'; // hope it's on PATH
  }
}

// Singleton instance — shared across all sessions
let _instance = null;

export function getLightPandaServer(binaryPath, opts) {
  if (!_instance) {
    _instance = new LightPandaServer(binaryPath, opts);
  }
  return _instance;
}

export async function stopLightPandaServer() {
  const instance = _instance;
  _instance = null;
  if (instance) await instance.stop();
}

// Best-effort cleanup when the host process goes away. No SIGTERM/SIGINT
// listeners: a library must not swallow the host's termination signals.
process.once('beforeExit', () => { stopLightPandaServer().catch(() => {}); });
process.once('exit', () => { try { _instance?.process?.kill('SIGTERM'); } catch { /* ignore */ } });

export default LightPandaServer;
