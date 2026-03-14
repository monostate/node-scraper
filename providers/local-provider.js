/**
 * LocalProvider — runs Xvfb + Chrome + xdotool on the local machine.
 *
 * Requires Linux with: xvfb, xdotool, chromium/google-chrome
 * Optional: x11vnc, noVNC (for VNC streaming)
 *
 * @example
 * import { createSession, LocalProvider } from '@monostate/node-scraper';
 *
 * const session = await createSession({
 *   mode: 'computer-use',
 *   provider: new LocalProvider({ screenWidth: 1280, screenHeight: 800 }),
 * });
 * await session.goto('https://example.com');
 * await session.clickAt(640, 400);
 * await session.close();
 */

import { ComputerUseProvider } from '../computer-use-provider.js';
import { spawn, execFile } from 'child_process';
import { createServer } from 'net';

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForProcess(proc, readyCheck, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Process startup timed out')), timeoutMs);
    const check = setInterval(async () => {
      try {
        if (await readyCheck()) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      } catch { /* still starting */ }
    }, 200);
    proc.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        clearInterval(check);
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

function execAsync(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export class LocalProvider extends ComputerUseProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.screenWidth=1280]
   * @param {number} [options.screenHeight=800]
   * @param {boolean} [options.enableVnc=false]
   * @param {string} [options.chromePath] - Path to Chrome/Chromium binary (auto-detected)
   * @param {string[]} [options.chromeArgs] - Additional Chrome launch args
   */
  constructor(options = {}) {
    super();
    this.screenWidth = options.screenWidth || 1280;
    this.screenHeight = options.screenHeight || 800;
    this.enableVnc = options.enableVnc ?? false;
    this.chromePath = options.chromePath || null;
    this.chromeArgs = options.chromeArgs || [];

    this._display = null;
    this._displayNum = null;
    this._cdpPort = null;
    this._vncPort = null;
    this._xvfbProc = null;
    this._chromeProc = null;
    this._vncProc = null;
    this._env = null;
    this._cdpWsUrl = null;
  }

  async start() {
    if (process.platform !== 'linux') {
      throw new Error(
        'LocalProvider requires Linux (Xvfb + xdotool). ' +
        'On macOS/Windows, use Docker or a remote provider.'
      );
    }

    // Find free ports
    this._cdpPort = await findFreePort();
    this._displayNum = 10 + Math.floor(Math.random() * 90); // :10-:99
    this._display = `:${this._displayNum}`;

    this._env = {
      ...process.env,
      DISPLAY: this._display,
      DBUS_SESSION_BUS_ADDRESS: '/dev/null',
    };

    // 1. Start Xvfb
    this._xvfbProc = spawn('Xvfb', [
      this._display,
      '-screen', '0', `${this.screenWidth}x${this.screenHeight}x24`,
      '-ac',
    ], { stdio: 'pipe', env: this._env });

    await new Promise(resolve => setTimeout(resolve, 500));

    // 2. Find Chrome binary
    const chromePath = this.chromePath || await this._findChrome();

    // 3. Start Chrome
    const chromeArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--remote-debugging-port=${this._cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--window-size=${this.screenWidth},${this.screenHeight}`,
      '--disable-features=dbus',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--no-first-run',
      '--user-data-dir=/tmp/chrome-local-provider-' + this._displayNum,
      ...this.chromeArgs,
      'about:blank',
    ];

    this._chromeProc = spawn(chromePath, chromeArgs, {
      stdio: 'pipe',
      env: this._env,
    });

    // Wait for CDP to be ready
    await waitForProcess(this._chromeProc, async () => {
      const res = await fetch(`http://127.0.0.1:${this._cdpPort}/json/version`);
      return res.ok;
    }, 15000);

    // Get the CDP WebSocket URL
    const versionRes = await fetch(`http://127.0.0.1:${this._cdpPort}/json/version`);
    const versionData = await versionRes.json();
    this._cdpWsUrl = versionData.webSocketDebuggerUrl;

    // 4. Optionally start VNC
    let vncUrl = null;
    if (this.enableVnc) {
      try {
        this._vncPort = await findFreePort();
        this._vncProc = spawn('x11vnc', [
          '-display', this._display,
          '-rfbport', String(this._vncPort),
          '-shared', '-nopw', '-forever',
        ], { stdio: 'pipe', env: this._env });
        await new Promise(resolve => setTimeout(resolve, 500));
        vncUrl = `vnc://127.0.0.1:${this._vncPort}`;
      } catch {
        // VNC is optional — don't fail if x11vnc is not installed
      }
    }

    return {
      cdpUrl: this._cdpWsUrl,
      vncUrl,
      screenSize: { width: this.screenWidth, height: this.screenHeight },
    };
  }

  async stop() {
    for (const proc of [this._vncProc, this._chromeProc, this._xvfbProc]) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    this._vncProc = null;
    this._chromeProc = null;
    this._xvfbProc = null;
  }

  async screenshot() {
    // Use CDP Page.captureScreenshot
    const pagesRes = await fetch(`http://127.0.0.1:${this._cdpPort}/json`);
    const pages = await pagesRes.json();
    const page = pages[0];
    if (!page) throw new Error('No open pages for screenshot');

    const wsUrl = page.webSocketDebuggerUrl;
    const { default: WebSocket } = await import('ws');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) {
          ws.close();
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve({ screenshot: `data:image/png;base64,${msg.result.data}` });
          }
        }
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); reject(new Error('Screenshot timed out')); }, 10000);
    });
  }

  // ── Coordinate-based actions via xdotool ──────────────────

  async mouseMove(x, y) {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    return { success: true };
  }

  async mouseClick(x, y, button = 'left') {
    const btn = { left: '1', right: '3', middle: '2' }[button] || '1';
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    await this._xdotool(['click', btn]);
    return { success: true };
  }

  async mouseDoubleClick(x, y, button = 'left') {
    const btn = { left: '1', right: '3', middle: '2' }[button] || '1';
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    await this._xdotool(['click', '--repeat', '2', '--delay', '50', btn]);
    return { success: true };
  }

  async mouseDrag(startX, startY, endX, endY) {
    await this._xdotool([
      'mousemove', '--', String(Math.round(startX)), String(Math.round(startY)),
    ]);
    await this._xdotool(['mousedown', '1']);
    await this._xdotool([
      'mousemove', '--', String(Math.round(endX)), String(Math.round(endY)),
    ]);
    await this._xdotool(['mouseup', '1']);
    return { success: true };
  }

  async scroll(x, y, direction, amount = 3) {
    await this._xdotool(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    const btn = direction === 'up' ? '4' : '5';
    await this._xdotool(['click', '--repeat', String(amount), '--delay', '50', btn]);
    return { success: true };
  }

  async pressKey(key) {
    await this._xdotool(['key', key]);
    return { success: true };
  }

  async typeText(text) {
    // Type in chunks to avoid buffer issues
    const CHUNK = 50;
    for (let i = 0; i < text.length; i += CHUNK) {
      const chunk = text.substring(i, i + CHUNK);
      await this._xdotool(['type', '--delay', '12', '--clearmodifiers', chunk]);
    }
    return { success: true };
  }

  async getCursorPosition() {
    const { stdout } = await this._xdotool(['getmouselocation', '--shell']);
    const x = parseInt(stdout.match(/X=(\d+)/)?.[1] || '0', 10);
    const y = parseInt(stdout.match(/Y=(\d+)/)?.[1] || '0', 10);
    return { x, y };
  }

  async getScreenSize() {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  // ── Internal helpers ──────────────────────────────────────

  async _xdotool(args) {
    return execAsync('xdotool', args, this._env);
  }

  async _findChrome() {
    const candidates = [
      'chromium-browser',
      'chromium',
      'google-chrome',
      'google-chrome-stable',
    ];
    for (const name of candidates) {
      try {
        const { stdout } = await execAsync('which', [name], this._env);
        if (stdout) return stdout;
      } catch { /* not found */ }
    }
    throw new Error(
      'Chrome/Chromium not found. Install with: apt-get install chromium ' +
      'or pass chromePath option.'
    );
  }
}

export default LocalProvider;
