import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  terminate, waitForExit, waitForHttpOk, waitForTcp, waitForPath,
  findFreePort, makeTempDir, removeDir, minimalEnv, allocateDisplay,
} from '../process-util.js';
import { startFixtureServer } from './fixtures/server.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('terminate', () => {
  it('stops a cooperative process with SIGTERM', async () => {
    const proc = spawn('sleep', ['30']);
    const t0 = Date.now();
    const res = await terminate(proc);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(res.forced, false);
    assert.equal(res.signal, 'SIGTERM');
    assert.equal(alive(proc.pid), false);
  });

  it('escalates to SIGKILL after the grace period', async () => {
    const proc = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
    await new Promise(r => setTimeout(r, 300)); // let the handler install
    const res = await terminate(proc, { graceMs: 200 });
    assert.equal(res.forced, true);
    assert.equal(res.signal, 'SIGKILL');
    assert.equal(alive(proc.pid), false);
  });

  it('resolves immediately for an already-exited process and is idempotent', async () => {
    const proc = spawn('true');
    await waitForExit(proc, 2000);
    const a = await terminate(proc);
    const b = await terminate(proc);
    assert.equal(a.forced, false);
    assert.equal(b.forced, false);
  });
});

describe('minimalEnv', () => {
  it('copies only the allow-listed keys plus extras', () => {
    process.env.SECRET_X_FOR_TEST = 'leak';
    const env = minimalEnv({ DISPLAY: ':1' });
    delete process.env.SECRET_X_FOR_TEST;
    assert.equal(env.DISPLAY, ':1');
    assert.equal('SECRET_X_FOR_TEST' in env, false);
    assert.equal(env.PATH, process.env.PATH);
  });
});

describe('allocateDisplay', () => {
  it('yields distinct displays and release() frees them', async () => {
    const lockDir = await makeTempDir('bnca-lock-test-');
    const a = await allocateDisplay({ lockDir, from: 50, to: 55 });
    const b = await allocateDisplay({ lockDir, from: 50, to: 55 });
    assert.notEqual(a.displayNum, b.displayNum);
    assert.equal(a.display, `:${a.displayNum}`);
    await a.release();
    const c = await allocateDisplay({ lockDir, from: 50, to: 55 });
    assert.equal(c.displayNum, a.displayNum);
    await b.release(); await c.release();
    await removeDir(lockDir);
  });

  it('throws when the range is exhausted', async () => {
    const lockDir = await makeTempDir('bnca-lock-test-');
    const a = await allocateDisplay({ lockDir, from: 60, to: 60 });
    await assert.rejects(() => allocateDisplay({ lockDir, from: 60, to: 60 }), /no free X display/);
    await a.release();
    await removeDir(lockDir);
  });
});

describe('temp dirs and ports', () => {
  it('makeTempDir creates under tmpdir and removeDir removes it (ignoring ENOENT)', async () => {
    const dir = await makeTempDir('bnca-test-');
    assert.ok(dir.startsWith(os.tmpdir()));
    await fs.writeFile(path.join(dir, 'f'), 'x');
    await removeDir(dir);
    await assert.rejects(() => fs.stat(dir));
    await removeDir(dir); // no throw
  });

  it('findFreePort returns a usable port', async () => {
    const port = await findFreePort();
    assert.ok(port > 0 && port < 65536);
  });
});

describe('waiters', () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await fx.close(); });

  it('waitForHttpOk resolves when the server answers within the timeout', async () => {
    const res = await waitForHttpOk(`${fx.url}/slow?ms=300`, { timeoutMs: 2000 });
    assert.equal(res.status, 200);
  });

  it('waitForHttpOk rejects when the timeout is too small', async () => {
    const port = await findFreePort(); // nothing listening
    await assert.rejects(() => waitForHttpOk(`http://127.0.0.1:${port}/`, { timeoutMs: 150 }), /timed out waiting for/);
  });

  it('waitForTcp resolves for a listening port and rejects for a closed one', async () => {
    await waitForTcp('127.0.0.1', fx.port, { timeoutMs: 1000 });
    const port = await findFreePort();
    await assert.rejects(() => waitForTcp('127.0.0.1', port, { timeoutMs: 150 }), /timed out/);
  });

  it('waitForPath resolves once the file appears', async () => {
    const dir = await makeTempDir('bnca-wait-');
    const p = path.join(dir, 'later');
    setTimeout(() => fs.writeFile(p, '1'), 100);
    await waitForPath(p, { timeoutMs: 2000 });
    await assert.rejects(() => waitForPath(path.join(dir, 'never'), { timeoutMs: 100 }), /timed out/);
    await removeDir(dir);
  });
});
