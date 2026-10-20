import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCapabilities, requireCapability, CapabilityError } from '../capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LP_BIN = path.join(here, '..', 'bin', 'lightpanda');

/** exec stub: every tool "exists" except the ones listed in `missing`. */
function execStub(missing = []) {
  return (cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const name = path.basename(cmd);
    const target = name === 'which' || name === 'command' ? path.basename(args[args.length - 1]) : name;
    if (missing.includes(target)) return done(Object.assign(new Error(`${target} not found`), { code: 'ENOENT' }));
    if (target === 'lightpanda') return done(null, '1.0.1\n', '');
    if (name === 'which') return done(null, `/usr/bin/${target}\n`, '');
    return done(null, 'ok\n', '');
  };
}

describe('checkCapabilities', () => {
  it('reports a missing tool with an install hint and disables the modes that need it', async () => {
    const report = await checkCapabilities({ exec: execStub(['xdotool']), platform: 'linux', chromePath: '/usr/bin/chromium', lightpandaPath: '/usr/bin/lightpanda' });
    const miss = report.missing.find(m => m.capability === 'xdotool');
    assert.deepEqual(miss, { capability: 'xdotool', install: 'apt-get install xdotool' });
    assert.equal(report.xdotool.available, false);
    assert.equal(report.xvfb.available, true);
    assert.equal(report.modes.computerUse, false);
    assert.equal(report.modes.vnc, false);
    assert.equal(report.modes.http, true);
  });

  it('enables computer-use and vnc on linux when everything is present', async () => {
    const report = await checkCapabilities({ exec: execStub(), platform: 'linux', chromePath: '/usr/bin/chromium', lightpandaPath: '/usr/bin/lightpanda', fileExists: async () => true });
    assert.equal(report.modes.computerUse, true);
    assert.equal(report.modes.vnc, true);
    assert.equal(report.modes.lightpanda, true);
    assert.equal(report.lightpanda.version, '1.0.1');
  });

  it('never enables computer-use off linux', async () => {
    const report = await checkCapabilities({ exec: execStub(), platform: 'darwin', chromePath: '/x/chrome', lightpandaPath: '/x/lp', fileExists: async () => true });
    assert.equal(report.modes.computerUse, false);
    assert.equal(report.modes.chrome, report.puppeteer.available && report.chrome.available);
  });

  it('real run: finds the bundled Lightpanda 1.0.1 when installed', { skip: !fs.existsSync(LP_BIN) && 'LightPanda not installed' }, async () => {
    const report = await checkCapabilities();
    assert.equal(report.lightpanda.available, true);
    assert.equal(report.lightpanda.version, '1.0.1');
    assert.equal(report.lightpanda.path, LP_BIN);
    assert.equal(typeof report.node, 'string');
    assert.equal(report.ws.available, true);
  });
});

describe('requireCapability', () => {
  it('throws CapabilityError with the install hint', async () => {
    const report = await checkCapabilities({ exec: execStub(['xdotool']), platform: 'linux' });
    assert.throws(() => requireCapability(report, 'xdotool'), (e) => e instanceof CapabilityError && e.code === 'CAPABILITY_MISSING' && e.capability === 'xdotool' && e.install === 'apt-get install xdotool');
    assert.doesNotThrow(() => requireCapability(report, 'xvfb'));
    assert.throws(() => requireCapability(report, 'nonsense'), /unknown capability/);
  });
});
