/**
 * LocalProvider — Xvfb + Chrome + xdotool (+ optional x11vnc) on this machine.
 *
 * Requires Linux with: xvfb, xdotool, chromium/google-chrome.
 * Optional: x11vnc (live view), imagemagick (`import`, desktop screenshots).
 *
 * Lifecycle is transactional: every resource acquired by start() (display
 * lock, temp profile, Xvfb, Chrome, x11vnc) is released in reverse order if a
 * later step fails, and stop() awaits process exit with SIGTERM→SIGKILL.
 * Children get a minimal environment, never the parent's secrets.
 *
 * @example
 * import { createSession, LocalProvider } from '@monostate/node-scraper';
 *
 * const session = await createSession({
 *   mode: 'computer-use',
 *   provider: new LocalProvider({ screenWidth: 1280, screenHeight: 800, enableVnc: true }),
 * });
 * await session.goto('https://example.com');
 * await session.clickAt(640, 400);
 * await session.close();
 */

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { connect } from 'node:net';
import { ComputerUseProvider } from '../computer-use-provider.js';
import { normalizeXdoKey } from '../keymap.js';
import { CapabilityError, INSTALL_HINTS } from '../capabilities.js';
import { findChromePath } from '../chrome-path.js';
import {
  terminate, waitForHttpOk, waitForTcp, waitForPath, findFreePort,
  makeTempDir, removeDir, minimalEnv, allocateDisplay,
} from '../process-util.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function execAsync(cmd, args, { env, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, { env, timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

function execBuffer(cmd, args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, { env, timeout, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function whichAsync(name) {
  return new Promise((resolve) => {
    nodeExecFile('which', [name], { timeout: 3000 }, (err, stdout) => resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0] : null));
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function probeVnc(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('data', (d) => { sock.destroy(); resolve(d.toString()); });
    sock.once('error', reject);
    sock.once('timeout', () => { sock.destroy(); reject(new Error('VNC banner timeout')); });
  });
}

const DEFAULT_DEPS = Object.freeze({
  spawn: nodeSpawn,
  execFile: execAsync,
  execFileBuffer: execBuffer,
  which: whichAsync,
  waitForPath,
  waitForHttpOk,
  waitForTcp,
  fetchJson,
  probeVnc,
  findChromePath,
  allocateDisplay,
  makeTempDir,
  removeDir,
  terminate,
  findFreePort,
});

export class LocalProvider extends ComputerUseProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.screenWidth=1280]
   * @param {number} [options.screenHeight=800]
   * @param {boolean} [options.enableVnc=false]
   * @param {{ bind?: string, password?: string|null, shared?: boolean }} [options.vnc] - loopback-only by default; a non-loopback bind requires a password
   * @param {string} [options.chromePath] - Chrome/Chromium binary (auto-detected)
   * @param {string[]} [options.chromeArgs] - Extra Chrome args
   * @param {Record<string,string>} [options.env] - Extra environment for children
   * @param {boolean} [options.inheritEnv=false] - Copy the whole parent environment into children (off: PATH/HOME/LANG/… only)
   * @param {boolean} [options.noSandbox] - Launch Chrome without its sandbox (default: BNCA_CHROME_NO_SANDBOX=1)
   * @param {number} [options.startTimeoutMs=15000]
   * @param {string|null} [options.profileDir=null] - Use (and keep) this profile dir instead of a temp one
   */
  constructor(options = {}) {
    super();
    this.screenWidth = options.screenWidth || 1280;
    this.screenHeight = options.screenHeight || 800;
    this.enableVnc = options.enableVnc ?? false;
    this.vncOptions = { bind: '127.0.0.1', password: null, shared: true, ...(options.vnc || {}) };
    this.chromePath = options.chromePath || null;
    this.chromeArgs = options.chromeArgs || [];
    this.extraEnv = options.env || {};
    this.inheritEnv = options.inheritEnv ?? false;
    this.noSandbox = options.noSandbox ?? (process.env.BNCA_CHROME_NO_SANDBOX === '1');
    this.startTimeoutMs = options.startTimeoutMs ?? 15000;
    this.profileDirOption = options.profileDir || null;
    this.platform = options.platform || process.platform;
    this.lockDir = options.lockDir || '/tmp';
    this._deps = { ...DEFAULT_DEPS, ...(options.deps || {}) };

    if (this.enableVnc && !LOOPBACK.has(this.vncOptions.bind) && !this.vncOptions.password) {
      throw new Error('VNC on a non-loopback bind requires vnc.password (set vnc.bind to 127.0.0.1 or provide a password)');
    }

    this._display = null;
    this._displayNum = null;
    this._displayLease = null;
    this._profileDir = null;
    this._lastProfileDir = null;
    this._profileIsTemp = false;
    this._cdpPort = null;
    this._cdpWsUrl = null;
    this._vncPort = null;
    this._xvfbProc = null;
    this._chromeProc = null;
    this._vncProc = null;
    this._env = null;
    this._info = null;
    this._starting = null;
    this._stopping = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start() {
    if (this._info) return this._info;
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    if (this.platform !== 'linux') {
      throw new Error('LocalProvider requires Linux (Xvfb + xdotool). On macOS/Windows, use Docker or a remote provider.');
    }
    if (this._stopping) await this._stopping;

    const d = this._deps;
    const cleanup = [];
    let step = 'display';
    try {
      // 1. Display number nobody else uses
      this._displayLease = await d.allocateDisplay({ lockDir: this.lockDir });
      this._display = this._displayLease.display;
      this._displayNum = this._displayLease.displayNum;
      cleanup.push(async () => { await this._displayLease?.release(); this._displayLease = null; this._display = null; this._displayNum = null; });

      // 2. Profile directory
      step = 'profile';
      this._profileIsTemp = !this.profileDirOption;
      this._profileDir = this.profileDirOption || await d.makeTempDir('bnca-chrome-profile-');
      this._lastProfileDir = this._profileDir;
      cleanup.push(async () => { if (this._profileIsTemp) await d.removeDir(this._profileDir); this._profileDir = null; });

      // 3. Environment for children: minimal unless asked otherwise
      const base = { DISPLAY: this._display, DBUS_SESSION_BUS_ADDRESS: '/dev/null', ...this.extraEnv };
      this._env = this.inheritEnv ? { ...process.env, ...base } : minimalEnv(base);

      // 4. Xvfb
      step = 'xvfb';
      this._xvfbProc = d.spawn('Xvfb', [
        this._display,
        '-screen', '0', `${this.screenWidth}x${this.screenHeight}x24`,
        '-ac', '-nolisten', 'tcp',
      ], { stdio: 'pipe', env: this._env });
      cleanup.push(async () => { await d.terminate(this._xvfbProc, { graceMs: 2000 }); this._xvfbProc = null; });
      await this._raceExit(this._xvfbProc, d.waitForPath(`/tmp/.X11-unix/X${this._displayNum}`, { timeoutMs: 5000 }));

      // 5. Chrome
      step = 'chrome';
      const chromePath = this.chromePath || await d.findChromePath();
      if (!chromePath) {
        throw new CapabilityError('chrome', INSTALL_HINTS.chrome);
      }
      this._cdpPort = await d.findFreePort();
      const chromeArgs = [
        `--remote-debugging-port=${this._cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${this._profileDir}`,
        '--window-position=0,0',
        `--window-size=${this.screenWidth},${this.screenHeight}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-background-networking',
        '--disable-features=dbus,TranslateUI',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        ...(this.noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        ...this.chromeArgs,
        'about:blank',
      ];
      this._chromeProc = d.spawn(chromePath, chromeArgs, { stdio: 'pipe', env: this._env });
      cleanup.push(async () => { await d.terminate(this._chromeProc, { graceMs: 3000 }); this._chromeProc = null; });
      const versionUrl = `http://127.0.0.1:${this._cdpPort}/json/version`;
      await this._raceExit(this._chromeProc, d.waitForHttpOk(versionUrl, { timeoutMs: this.startTimeoutMs }));
      const version = await d.fetchJson(versionUrl);
      this._cdpWsUrl = version.webSocketDebuggerUrl;
      if (!this._cdpWsUrl) throw new Error('Chrome did not report a webSocketDebuggerUrl');

      // 6. Optional VNC, verified before we claim it
      step = 'vnc';
      let vnc = null;
      let vncUrl = null;
      if (this.enableVnc) {
        const { bind, password, shared } = this.vncOptions;
        const loopbackOnly = LOOPBACK.has(bind);
        this._vncPort = await d.findFreePort();
        const vncArgs = [
          '-display', this._display,
          '-rfbport', String(this._vncPort),
          '-forever',
          ...(shared ? ['-shared'] : []),
          ...(loopbackOnly ? ['-localhost'] : ['-listen', bind]),
          ...(password ? ['-passwd', password] : ['-nopw']),
        ];
        this._vncProc = d.spawn('x11vnc', vncArgs, { stdio: 'pipe', env: this._env });
        cleanup.push(async () => { await d.terminate(this._vncProc, { graceMs: 2000 }); this._vncProc = null; });
        const host = loopbackOnly ? '127.0.0.1' : bind;
        await this._raceExit(this._vncProc, d.waitForTcp(host, this._vncPort, { timeoutMs: 5000 }));
        const banner = await d.probeVnc(host, this._vncPort);
        if (!/^RFB/.test(String(banner))) throw new Error(`unexpected VNC banner: ${String(banner).slice(0, 20)}`);
        vnc = { host, port: this._vncPort, auth: password ? 'password' : 'none', loopbackOnly };
        vncUrl = `vnc://${host}:${this._vncPort}`;
      }

      this._info = {
        cdpUrl: this._cdpWsUrl,
        vncUrl,
        vnc,
        screenSize: { width: this.screenWidth, height: this.screenHeight },
        display: this._display,
        profileDir: this._profileDir,
      };
      return this._info;
    } catch (err) {
      await this._runCleanup(cleanup);
      const error = new Error(`LocalProvider start failed at ${step}: ${err.message}`);
      error.step = step;
      error.cause = err;
      if (err instanceof CapabilityError) { error.code = err.code; error.capability = err.capability; error.install = err.install; }
      throw error;
    }
  }

  /** Reject as soon as the child exits while we wait for its readiness signal. */
  _raceExit(proc, readyPromise) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onExit = (code, signal) => {
        if (settled) return;
        settled = true;
        reject(new Error(`${proc.name || 'process'} exited (code ${code}${signal ? `, ${signal}` : ''}) before becoming ready`));
      };
      proc.once('exit', onExit);
      proc.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
      readyPromise.then(
        (v) => { if (!settled) { settled = true; proc.off('exit', onExit); resolve(v); } },
        (e) => { if (!settled) { settled = true; proc.off('exit', onExit); reject(e); } },
      );
    });
  }

  async _runCleanup(fns) {
    for (const fn of fns.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
  }

  /**
   * Stop everything and wait for it to be gone. Idempotent.
   * @param {{ graceMs?: number }} [opts]
   */
  async stop({ graceMs = 2000 } = {}) {
    if (this._stopping) return this._stopping;
    this._stopping = this._stop(graceMs).finally(() => { this._stopping = null; });
    return this._stopping;
  }

  async _stop(graceMs) {
    if (this._starting) { try { await this._starting; } catch { /* start already rolled back */ } }
    const d = this._deps;
    for (const key of ['_vncProc', '_chromeProc', '_xvfbProc']) {
      const proc = this[key];
      if (proc) {
        try { await d.terminate(proc, { graceMs }); } catch { /* ignore */ }
        this[key] = null;
      }
    }
    if (this._profileDir && this._profileIsTemp) {
      try { await d.removeDir(this._profileDir); } catch { /* ignore */ }
    }
    this._profileDir = null;
    if (this._displayLease) {
      try { await this._displayLease.release(); } catch { /* ignore */ }
      this._displayLease = null;
    }
    this._display = null;
    this._displayNum = null;
    this._cdpPort = null;
    this._cdpWsUrl = null;
    this._vncPort = null;
    this._env = null;
    this._info = null;
  }

  // ── Capabilities & screenshots ────────────────────────────

  async getCapabilities() {
    const d = this._deps;
    return {
      desktopScreenshot: Boolean(await d.which('import')),
      pageScreenshot: true,
      vnc: Boolean(this._info?.vnc),
      nativeInput: true,
    };
  }

  /**
   * @param {{ space?: 'desktop'|'page' }} [opts]
   */
  async screenshot({ space = 'desktop' } = {}) {
    if (space === 'page') return this._pageScreenshot();
    const d = this._deps;
    const importPath = await d.which('import');
    if (!importPath) throw new CapabilityError('imagemagick', INSTALL_HINTS.imagemagick);
    const png = await d.execFileBuffer(importPath, ['-window', 'root', 'png:-'], { env: this._env });
    return {
      screenshot: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      coordinateSpace: 'desktop',
      width: this.screenWidth,
      height: this.screenHeight,
      dpr: 1,
    };
  }

  async _pageScreenshot() {
    if (!this._cdpPort) throw new Error('provider not started');
    const pages = await this._deps.fetchJson(`http://127.0.0.1:${this._cdpPort}/json`);
    const page = Array.isArray(pages) ? pages.find(p => p.type === 'page') || pages[0] : null;
    if (!page) throw new Error('No open pages for screenshot');
    const { default: WebSocket } = await import('ws');
    const data = await new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error('Screenshot timed out')); }, 10000);
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result.data);
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    return {
      screenshot: `data:image/png;base64,${data}`,
      coordinateSpace: 'page',
      width: this.screenWidth,
      height: this.screenHeight,
      dpr: 1,
    };
  }

  // ── Native input via xdotool ──────────────────────────────

  _btn(button) {
    return { left: '1', middle: '2', right: '3' }[button] || '1';
  }

  async mouseMove(x, y) {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    return { success: true };
  }

  async mouseDown(x, y, button = 'left') {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    await this._xdotool(['mousedown', this._btn(button)]);
    return { success: true };
  }

  async mouseUp(button = 'left') {
    await this._xdotool(['mouseup', this._btn(button)]);
    return { success: true };
  }

  async mouseClick(x, y, button = 'left') {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    await this._xdotool(['click', this._btn(button)]);
    return { success: true };
  }

  async mouseDoubleClick(x, y, button = 'left') {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    await this._xdotool(['click', '--repeat', '2', '--delay', '50', this._btn(button)]);
    return { success: true };
  }

  async scroll(x, y, direction, amount = 3) {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    const btn = direction === 'up' ? '4' : '5';
    await this._xdotool(['click', '--repeat', String(Math.max(1, Math.round(amount))), '--delay', '50', btn]);
    return { success: true };
  }

  /** Desktop key press; accepts Puppeteer/W3C names ('Enter', 'Control+Shift+ArrowLeft'). */
  async pressKey(key) {
    await this._xdotool(['key', '--clearmodifiers', normalizeXdoKey(key)]);
    return { success: true };
  }

  async typeText(text) {
    const CHUNK = 50;
    for (let i = 0; i < text.length; i += CHUNK) {
      await this._xdotool(['type', '--delay', '12', '--clearmodifiers', '--', text.substring(i, i + CHUNK)]);
    }
    return { success: true };
  }

  async getCursorPosition() {
    const { stdout } = await this._xdotool(['getmouselocation', '--shell']);
    return {
      x: parseInt(stdout.match(/X=(\d+)/)?.[1] || '0', 10),
      y: parseInt(stdout.match(/Y=(\d+)/)?.[1] || '0', 10),
    };
  }

  async getScreenSize() {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  _xdotool(args) {
    if (!this._env) throw new Error('provider not started');
    return this._deps.execFile('xdotool', args, { env: this._env });
  }
}

export default LocalProvider;
