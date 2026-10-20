import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import net from 'node:net';
import { LocalProvider } from '../providers/local-provider.js';

const exec = promisify(execFile);
const isLinux = process.platform === 'linux';
const skip = !isLinux && 'Linux-only (Xvfb/xdotool)';
const noSandbox = process.env.BNCA_CHROME_NO_SANDBOX === '1';

async function count(pattern) {
  try { const { stdout } = await exec('pgrep', ['-fc', pattern]); return Number(stdout.trim()); } catch { return 0; }
}
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('LocalProvider on real Xvfb/Chrome (Linux)', { timeout: 120000, skip }, () => {
  let provider;
  after(async () => { await provider?.stop(); });

  it('starts, exposes CDP, captures a desktop screenshot and binds VNC to loopback only', async () => {
    provider = new LocalProvider({ enableVnc: true, screenWidth: 1280, screenHeight: 800, noSandbox });
    const info = await provider.start();
    const version = await (await fetch(`http://127.0.0.1:${new URL(info.cdpUrl).port}/json/version`)).json();
    assert.ok(version.webSocketDebuggerUrl);
    assert.match(info.display, /^:\d+$/);
    const caps = await provider.getCapabilities();
    assert.equal(caps.desktopScreenshot, true);
    const shot = await provider.screenshot({ space: 'desktop' });
    assert.equal(shot.coordinateSpace, 'desktop');
    const png = Buffer.from(shot.screenshot.split(',')[1], 'base64');
    assert.deepEqual(pngSize(png), { width: 1280, height: 800 });
    assert.equal(info.vnc.loopbackOnly, true);
    const banner = await new Promise((resolve, reject) => {
      const s = net.connect(info.vnc.port, '127.0.0.1');
      s.setTimeout(3000);
      s.once('data', d => { s.destroy(); resolve(d.toString()); });
      s.once('error', reject); s.once('timeout', () => reject(new Error('vnc timeout')));
    });
    assert.match(banner, /^RFB/);
    const { stdout } = await exec('ss', ['-ltn']).catch(() => ({ stdout: '' }));
    const line = stdout.split('\n').find(l => l.includes(`:${info.vnc.port} `));
    if (line) assert.match(line, /127\.0\.0\.1:/, 'VNC bound to loopback');
  });

  it('stop() leaves no processes, sockets or profile behind', async () => {
    const info = provider._info;
    const display = info.display;
    await provider.stop();
    assert.equal(await count(`Xvfb ${display} `), 0);
    await assert.rejects(() => fs.stat(info.profileDir));
    await assert.rejects(() => fs.stat(`/tmp/.X11-unix/X${display.slice(1)}`));
  });

  it('5 start/stop cycles return the process count to baseline', async () => {
    const baseXvfb = await count('Xvfb');
    const baseChrome = await count('chromium');
    for (let i = 0; i < 5; i++) {
      const p = new LocalProvider({ noSandbox });
      await p.start();
      await p.stop();
    }
    assert.equal(await count('Xvfb'), baseXvfb);
    assert.equal(await count('chromium'), baseChrome);
  });
});
