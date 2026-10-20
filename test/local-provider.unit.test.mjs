import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { LocalProvider } from '../providers/local-provider.js';
import { CapabilityError } from '../capabilities.js';
import { makeTempDir, removeDir } from '../process-util.js';

/** Fake ChildProcess: alive until kill(); records signals. */
function fakeChild(name) {
  const child = new EventEmitter();
  child.name = name;
  child.pid = Math.floor(Math.random() * 10000) + 1000;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig = 'SIGTERM') => {
    child.signals.push(sig);
    child.killed = true;
    setTimeout(() => { if (child.exitCode === null) { child.exitCode = null; child.signalCode = sig; child.emit('exit', null, sig); } }, 5);
    return true;
  };
  return child;
}

function makeDeps(overrides = {}) {
  const spawned = [];
  const deps = {
    spawn: (cmd, args, opts) => { const c = fakeChild(cmd); c.args = args; c.opts = opts; spawned.push(c); return c; },
    waitForPath: async () => {},
    waitForHttpOk: async () => ({ ok: true }),
    fetchJson: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake' }),
    waitForTcp: async () => {},
    probeVnc: async () => 'RFB 003.008',
    which: async (name) => `/usr/bin/${name}`,
    execFile: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  };
  return { deps, spawned };
}

describe('LocalProvider (unit, stubbed processes)', () => {
  let lockDir;
  beforeEach(async () => { lockDir = await makeTempDir('bnca-lp-locks-'); });
  afterEach(async () => { await removeDir(lockDir); });

  const opts = (deps, extra = {}) => ({ platform: 'linux', lockDir, chromePath: '/usr/bin/chromium', startTimeoutMs: 300, deps, ...extra });

  it('rolls back Xvfb, the temp profile and the display lock when Chrome never becomes ready', async () => {
    const { deps, spawned } = makeDeps({ waitForHttpOk: async () => { throw new Error('timed out waiting for http://127.0.0.1:1/json/version'); } });
    const p = new LocalProvider(opts(deps));
    await assert.rejects(() => p.start(), /start failed at chrome/);
    const xvfb = spawned.find(c => c.name === 'Xvfb');
    const chrome = spawned.find(c => c.name === '/usr/bin/chromium');
    assert.ok(xvfb && chrome, 'both children were spawned');
    assert.ok(xvfb.signals.includes('SIGTERM'), 'Xvfb terminated');
    assert.ok(chrome.signals.includes('SIGTERM'), 'Chrome terminated');
    assert.equal(p._profileDir, null);
    await assert.rejects(() => fs.stat(p._lastProfileDir), 'temp profile removed');
    assert.deepEqual(await fs.readdir(lockDir), [], 'display lock released');
  });

  it('concurrent start() calls share one attempt and spawn each child once', async () => {
    const { deps, spawned } = makeDeps();
    const p = new LocalProvider(opts(deps));
    const [a, b] = await Promise.all([p.start(), p.start()]);
    assert.equal(a, b);
    assert.equal(spawned.length, 2, 'Xvfb + Chrome only');
    assert.equal(a.cdpUrl, 'ws://127.0.0.1:1/devtools/browser/fake');
    assert.match(a.display, /^:\d+$/);
    assert.ok(a.profileDir);
    assert.equal(a.vnc, null);
    await p.stop();
  });

  it('stop() terminates children in reverse order, removes the profile, releases the display, and is idempotent', async () => {
    const { deps, spawned } = makeDeps();
    const p = new LocalProvider(opts(deps));
    const info = await p.start();
    await Promise.all([p.stop(), p.stop()]);
    await p.stop();
    assert.ok(spawned.every(c => c.signals.includes('SIGTERM')));
    await assert.rejects(() => fs.stat(info.profileDir));
    assert.deepEqual(await fs.readdir(lockDir), []);
    // can start again afterwards
    const again = await p.start();
    assert.ok(again.cdpUrl);
    await p.stop();
  });

  it('passes a minimal environment to children unless inheritEnv is set', async () => {
    process.env.SECRET_FOR_PROVIDER_TEST = 'leak';
    try {
      const { deps, spawned } = makeDeps();
      const p = new LocalProvider(opts(deps, { env: { EXTRA_VAR: '1' } }));
      await p.start();
      for (const c of spawned) {
        assert.equal('SECRET_FOR_PROVIDER_TEST' in c.opts.env, false, `${c.name} must not inherit secrets`);
        assert.match(c.opts.env.DISPLAY, /^:\d+$/);
        assert.equal(c.opts.env.EXTRA_VAR, '1');
      }
      await p.stop();
      const { deps: deps2, spawned: spawned2 } = makeDeps();
      const p2 = new LocalProvider(opts(deps2, { inheritEnv: true }));
      await p2.start();
      assert.equal(spawned2[0].opts.env.SECRET_FOR_PROVIDER_TEST, 'leak');
      await p2.stop();
    } finally {
      delete process.env.SECRET_FOR_PROVIDER_TEST;
    }
  });

  it('keeps the Chrome sandbox unless noSandbox is set', async () => {
    const { deps, spawned } = makeDeps();
    // the default reads BNCA_CHROME_NO_SANDBOX; pin it off for this assertion
    const p = new LocalProvider(opts(deps, { noSandbox: false }));
    await p.start();
    const chrome = spawned.find(c => c.name === '/usr/bin/chromium');
    assert.ok(!chrome.args.includes('--no-sandbox'));
    assert.ok(chrome.args.includes('--window-position=0,0'));
    assert.ok(chrome.args.some(a => a.startsWith('--user-data-dir=')));
    await p.stop();
    const { deps: d2, spawned: s2 } = makeDeps();
    const p2 = new LocalProvider(opts(d2, { noSandbox: true }));
    await p2.start();
    assert.ok(s2.find(c => c.name === '/usr/bin/chromium').args.includes('--no-sandbox'));
    await p2.stop();
  });

  it('refuses VNC on a non-loopback bind without a password', () => {
    assert.throws(() => new LocalProvider({ enableVnc: true, vnc: { bind: '0.0.0.0' } }), /vnc\.password/);
  });

  it('starts x11vnc loopback-only with no password by default and verifies the listener', async () => {
    const { deps, spawned } = makeDeps();
    const p = new LocalProvider(opts(deps, { enableVnc: true }));
    const info = await p.start();
    const vnc = spawned.find(c => c.name === 'x11vnc');
    assert.ok(vnc, 'x11vnc spawned');
    assert.ok(vnc.args.includes('-localhost'));
    assert.ok(vnc.args.includes('-nopw'));
    assert.equal(info.vnc.host, '127.0.0.1');
    assert.equal(info.vnc.auth, 'none');
    assert.equal(info.vnc.loopbackOnly, true);
    assert.equal(info.vncUrl, `vnc://127.0.0.1:${info.vnc.port}`);
    await p.stop();
  });

  it('fails the start when the VNC listener never answers', async () => {
    const { deps } = makeDeps({ waitForTcp: async () => { throw new Error('timed out waiting for tcp'); } });
    const p = new LocalProvider(opts(deps, { enableVnc: true }));
    await assert.rejects(() => p.start(), /start failed at vnc/);
    assert.deepEqual(await fs.readdir(lockDir), [], 'rolled back');
  });

  it('desktop screenshot requires ImageMagick import and reports a CapabilityError otherwise', async () => {
    const { deps } = makeDeps({ which: async (name) => (name === 'import' ? null : `/usr/bin/${name}`) });
    const p = new LocalProvider(opts(deps));
    await p.start();
    const caps = await p.getCapabilities();
    assert.equal(caps.desktopScreenshot, false);
    assert.equal(caps.pageScreenshot, true);
    assert.equal(caps.vnc, false);
    await assert.rejects(() => p.screenshot({ space: 'desktop' }), (e) => e instanceof CapabilityError && e.capability === 'imagemagick');
    await p.stop();
  });

  it('rejects off Linux with a clear message', async () => {
    const { deps } = makeDeps();
    const p = new LocalProvider({ platform: 'darwin', deps });
    await assert.rejects(() => p.start(), /requires Linux/);
  });
});

describe('LocalProvider child stdio (review fix)', () => {
  it('ignores stdout, drains stderr and reports its tail in start failures', async () => {
    const lockDir = await makeTempDir('bnca-lp-locks-');
    try {
      let spawnedRef;
      const { deps, spawned } = makeDeps({
        waitForHttpOk: async () => {
          const chrome = spawnedRef.find(c => c.name === '/usr/bin/chromium');
          chrome.stderr.emit('data', Buffer.from('[1:1:FATAL] cannot open display :42\n'));
          throw new Error('timed out waiting for http://127.0.0.1:1/json/version');
        },
      });
      spawnedRef = spawned;
      const p = new LocalProvider({ platform: 'linux', lockDir, chromePath: '/usr/bin/chromium', startTimeoutMs: 300, deps });
      await assert.rejects(() => p.start(), /cannot open display/);
      const chrome = spawned.find(c => c.name === '/usr/bin/chromium');
      assert.deepEqual(chrome.opts.stdio, ['ignore', 'ignore', 'pipe']);
      const xvfb = spawned.find(c => c.name === 'Xvfb');
      assert.deepEqual(xvfb.opts.stdio, ['ignore', 'ignore', 'pipe']);
    } finally {
      await removeDir(lockDir);
    }
  });
});
