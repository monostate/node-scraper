import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import LightPandaServer, { getLightPandaServer, stopLightPandaServer } from '../lightpanda-server.js';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_BIN = path.join(here, '..', 'bin', 'lightpanda');
const HANG_BIN = path.join(here, 'fixtures', 'fake-lightpanda-hang.sh');
const lpAvailable = fs.existsSync(REAL_BIN);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('LightPandaServer lifecycle', { timeout: 30000 }, () => {
  after(async () => { await stopLightPandaServer(); });

  it('concurrent start() calls share one process and one endpoint', { skip: !lpAvailable && 'LightPanda not installed' }, async () => {
    const server = new LightPandaServer(REAL_BIN);
    const [a, b] = await Promise.all([server.start(), server.start()]);
    assert.equal(a, b);
    assert.match(a, /^ws:\/\/127\.0\.0\.1:\d+$/);
    const pid = server.process.pid;
    const { stdout } = await exec('pgrep', ['-f', `lightpanda serve --host 127.0.0.1 --port ${server.port}`]).catch(() => ({ stdout: '' }));
    const pids = stdout.trim().split('\n').filter(Boolean);
    assert.equal(pids.length, 1, `expected one serve process, got ${pids.join(',')}`);
    assert.equal(await server.version(), '1.0.1');
    assert.equal(server.isRunning(), true);
    await server.stop();
    assert.equal(server.isRunning(), false);
    assert.equal(alive(pid), false, 'process still alive after stop()');
    await server.stop(); // idempotent
  });

  it('start() after stop() works again', { skip: !lpAvailable && 'LightPanda not installed' }, async () => {
    const server = new LightPandaServer(REAL_BIN);
    const first = await server.start();
    await server.stop();
    const second = await server.start();
    assert.match(second, /^ws:\/\//);
    assert.notEqual(server.process, null);
    await server.stop();
    assert.ok(first && second);
  });

  it('rejects when the binary never becomes ready and leaves no child behind', async () => {
    const server = new LightPandaServer(HANG_BIN, { startTimeoutMs: 800 });
    const t0 = Date.now();
    let pid;
    const p = server.start();
    // give spawn a tick so we can capture the pid
    await new Promise(r => setTimeout(r, 50));
    pid = server.process?.pid;
    await assert.rejects(p, /failed to start within 800ms/);
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(pid, 'child was spawned');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(pid), false, 'hanging child must be terminated');
    assert.equal(server.isRunning(), false);
  });

  it('rejects when the binary does not exist', async () => {
    const server = new LightPandaServer('/nonexistent/lightpanda', { startTimeoutMs: 2000 });
    await assert.rejects(server.start(), /Failed to start LightPanda|ENOENT/);
    assert.equal(server.isRunning(), false);
  });

  it('getLightPandaServer returns a singleton and stopLightPandaServer is async', async () => {
    const a = getLightPandaServer(HANG_BIN);
    const b = getLightPandaServer();
    assert.equal(a, b);
    const r = stopLightPandaServer();
    assert.ok(r && typeof r.then === 'function', 'stopLightPandaServer must return a promise');
    await r;
  });
});
