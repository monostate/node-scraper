/**
 * Process, port, filesystem and environment helpers shared by the
 * LightPanda server, LocalProvider and the browser pool.
 */
import { createServer, connect } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hasExited(proc) {
  return !proc || proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Wait for a child process to exit.
 * @returns {Promise<boolean>} true if it exited within timeoutMs
 */
export function waitForExit(proc, timeoutMs = 5000) {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onExit = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); proc.off('exit', onExit); };
    proc.once('exit', onExit);
  });
}

/**
 * SIGTERM, wait `graceMs`, then SIGKILL. Never throws for a dead pid.
 * @returns {Promise<{ code: number|null, signal: string|null, forced: boolean }>}
 */
export async function terminate(proc, { graceMs = 2000 } = {}) {
  if (hasExited(proc)) {
    return { code: proc?.exitCode ?? null, signal: proc?.signalCode ?? null, forced: false };
  }
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  if (await waitForExit(proc, graceMs)) {
    return { code: proc.exitCode, signal: proc.signalCode, forced: false };
  }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  await waitForExit(proc, Math.max(1000, graceMs));
  return { code: proc.exitCode, signal: proc.signalCode, forced: true };
}

/** Poll an HTTP endpoint until it answers with a 2xx. */
export async function waitForHttpOk(url, { timeoutMs = 10000, intervalMs = 100, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`aborted while waiting for ${url}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(50, Math.min(intervalMs * 5, deadline - Date.now()))) });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${url}${lastError ? ` (${lastError.message})` : ''}`);
}

/** Poll until a TCP connection to host:port succeeds. */
export async function waitForTcp(host, port, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = connect({ host, port });
      const done = (v) => { sock.destroy(); resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(Math.max(50, intervalMs * 5), () => done(false));
    });
    if (ok) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for tcp ${host}:${port}`);
}

/** Poll until a filesystem path exists. */
export async function waitForPath(p, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fs.access(p); return; } catch { /* not yet */ }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for path ${p}`);
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function makeTempDir(prefix = 'bnca-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(p) {
  if (!p) return;
  await fs.rm(p, { recursive: true, force: true });
}

const DEFAULT_INHERIT = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XAUTHORITY', 'TZ'];

/**
 * Build a child environment that carries only an allow-list of parent keys.
 * Application secrets are therefore never inherited by browsers or X servers.
 */
export function minimalEnv(extra = {}, { inherit = DEFAULT_INHERIT, source = process.env } = {}) {
  const env = {};
  for (const key of inherit) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, ...extra };
}

/**
 * Reserve an X display number nobody else is using. Besides the X server's
 * own lock/socket files, a private lock file keeps two concurrent providers
 * in the same process tree from racing for the same number.
 */
export async function allocateDisplay({ from = 10, to = 99, lockDir = '/tmp' } = {}) {
  for (let n = from; n <= to; n++) {
    const inUse = await Promise.all([
      fs.access(`/tmp/.X${n}-lock`).then(() => true, () => false),
      fs.access(`/tmp/.X11-unix/X${n}`).then(() => true, () => false),
    ]);
    if (inUse.some(Boolean)) continue;
    const lockPath = path.join(lockDir, `.bnca-display-${n}.lock`);
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    await handle.writeFile(String(process.pid));
    await handle.close();
    let released = false;
    return {
      display: `:${n}`,
      displayNum: n,
      lockPath,
      async release() {
        if (released) return;
        released = true;
        await fs.rm(lockPath, { force: true });
      },
    };
  }
  throw new Error(`no free X display in range :${from}-:${to}`);
}

export default {
  terminate, waitForExit, waitForHttpOk, waitForTcp, waitForPath,
  findFreePort, makeTempDir, removeDir, minimalEnv, allocateDisplay,
};
