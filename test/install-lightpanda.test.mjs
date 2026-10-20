import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  LIGHTPANDA_VERSION, LIGHTPANDA_CHECKSUMS, assetNameFor, downloadUrlFor,
  sha256File, download, binaryVersion, installLightpanda,
} from '../scripts/install-lightpanda.js';
import { makeTempDir, removeDir } from '../process-util.js';

const GOOD_BODY = Buffer.from('#!/bin/sh\necho 1.0.1\n');
const GOOD_SHA = createHash('sha256').update(GOOD_BODY).digest('hex');

// A tiny stand-in for github.com/releases: routes decide the behavior.
async function startReleaseHost() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('/good')) { res.writeHead(200, { 'Content-Length': GOOD_BODY.length }); return res.end(GOOD_BODY); }
    if (req.url.endsWith('/corrupt')) { res.writeHead(200); return res.end('#!/bin/sh\necho corrupted\n'); }
    if (req.url.endsWith('/loop')) { res.writeHead(302, { Location: req.url }); return res.end(); }
    if (req.url.endsWith('/redirect-once')) { res.writeHead(302, { Location: req.url.replace('/redirect-once', '/good') }); return res.end(); }
    if (req.url.endsWith('/slow')) { return setTimeout(() => { res.writeHead(200); res.end(GOOD_BODY); }, 2000); }
    res.writeHead(404); res.end('nope');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise(r => server.close(r)) };
}

describe('install-lightpanda constants', () => {
  it('pins 1.0.1 with four checksums and github download URLs', () => {
    assert.equal(LIGHTPANDA_VERSION, '1.0.1');
    assert.deepEqual(Object.keys(LIGHTPANDA_CHECKSUMS).sort(), ['lightpanda-aarch64-linux', 'lightpanda-aarch64-macos', 'lightpanda-x86_64-linux', 'lightpanda-x86_64-macos']);
    for (const v of Object.values(LIGHTPANDA_CHECKSUMS)) assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(downloadUrlFor('lightpanda-x86_64-linux'), 'https://github.com/lightpanda-io/browser/releases/download/1.0.1/lightpanda-x86_64-linux');
  });

  it('maps platform/arch to asset names', () => {
    assert.equal(assetNameFor({ platform: 'darwin', arch: 'arm64' }), 'lightpanda-aarch64-macos');
    assert.equal(assetNameFor({ platform: 'linux', arch: 'x64' }), 'lightpanda-x86_64-linux');
    assert.equal(assetNameFor({ platform: 'linux', arch: 'arm64' }), 'lightpanda-aarch64-linux');
    assert.equal(assetNameFor({ platform: 'win32', arch: 'x64' }), null);
    assert.equal(assetNameFor({ platform: 'linux', arch: 'ia32' }), null);
  });
});

describe('download()', () => {
  let host, dir;
  before(async () => { host = await startReleaseHost(); dir = await makeTempDir('bnca lp dl '); });
  after(async () => { await host.close(); await removeDir(dir); });

  it('writes to a .part file and renames atomically on success', async () => {
    const dest = path.join(dir, 'bin-good');
    await download(`${host.base}/good`, dest);
    assert.equal(await sha256File(dest), GOOD_SHA);
    const leftovers = (await fs.readdir(dir)).filter(f => f.includes('.part-'));
    assert.deepEqual(leftovers, []);
  });

  it('follows a bounded number of redirects and rejects a loop', async () => {
    const dest = path.join(dir, 'bin-redirect');
    await download(`${host.base}/redirect-once`, dest);
    assert.equal(await sha256File(dest), GOOD_SHA);
    await assert.rejects(() => download(`${host.base}/loop`, path.join(dir, 'bin-loop'), { maxRedirects: 5 }), /redirect/i);
    await assert.rejects(() => fs.stat(path.join(dir, 'bin-loop')));
  });

  it('rejects non-2xx and leaves no file behind', async () => {
    const dest = path.join(dir, 'bin-404');
    await assert.rejects(() => download(`${host.base}/missing`, dest), /HTTP 404/);
    await assert.rejects(() => fs.stat(dest));
  });

  it('times out', async () => {
    const dest = path.join(dir, 'bin-slow');
    await assert.rejects(() => download(`${host.base}/slow`, dest, { timeoutMs: 200 }), /timed out|abort/i);
    await assert.rejects(() => fs.stat(dest));
  });
});

describe('installLightpanda()', () => {
  let host, dir;
  const asset = assetNameFor() || 'lightpanda-x86_64-linux';
  before(async () => { host = await startReleaseHost(); dir = await makeTempDir('bnca lp install '); });
  after(async () => { await host.close(); await removeDir(dir); });

  const opts = (binDir, extra = {}) => ({
    binDir,
    log: () => {},
    checksums: { [asset]: GOOD_SHA },
    urlFor: () => `${host.base}/good`,
    ...extra,
  });

  it('installs when the checksum and health check pass', async () => {
    const binDir = path.join(dir, 'ok');
    const r = await installLightpanda(opts(binDir));
    assert.equal(r.status, 'installed', JSON.stringify(r));
    assert.equal(r.version, '1.0.1');
    const st = await fs.stat(path.join(binDir, 'lightpanda'));
    assert.ok(st.mode & 0o111, 'binary is executable');
    assert.deepEqual((await fs.readdir(binDir)).filter(f => f.includes('.part-')), []);
  });

  it('rejects a corrupted download and leaves nothing at the destination', async () => {
    const binDir = path.join(dir, 'corrupt');
    const r = await installLightpanda(opts(binDir, { urlFor: () => `${host.base}/corrupt` }));
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'checksum_mismatch');
    await assert.rejects(() => fs.stat(path.join(binDir, 'lightpanda')));
  });

  it('fails on a redirect loop', async () => {
    const r = await installLightpanda(opts(path.join(dir, 'loop'), { urlFor: () => `${host.base}/loop` }));
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /redirect/i);
  });

  it('reports present when the existing binary already has the pinned version', async () => {
    const binDir = path.join(dir, 'present');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, 'lightpanda'), '#!/bin/sh\necho 1.0.1\n', { mode: 0o755 });
    host.hits.length = 0;
    const r = await installLightpanda(opts(binDir));
    assert.equal(r.status, 'present');
    assert.equal(host.hits.length, 0, 'no download attempted');
  });

  it('re-downloads when the existing binary reports another version', async () => {
    const binDir = path.join(dir, 'stale');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, 'lightpanda'), '#!/bin/sh\necho 0.2.5\n', { mode: 0o755 });
    const r = await installLightpanda(opts(binDir));
    assert.equal(r.status, 'installed');
    assert.equal(await binaryVersion(path.join(binDir, 'lightpanda')), '1.0.1');
  });

  it('skips when asked', async () => {
    const r = await installLightpanda(opts(path.join(dir, 'skip'), { skip: true }));
    assert.equal(r.status, 'skipped');
  });

  it('reports unsupported platforms', async () => {
    const r = await installLightpanda(opts(path.join(dir, 'win'), { platform: 'win32', arch: 'x64' }));
    assert.equal(r.status, 'unsupported');
  });

  it('fails the health check when the binary does not report the pinned version', async () => {
    const binDir = path.join(dir, 'health');
    const r = await installLightpanda(opts(binDir, { healthCheck: async () => '9.9.9' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'health_check');
    await assert.rejects(() => fs.stat(path.join(binDir, 'lightpanda')));
  });
});

describe('binary discovery honours LIGHTPANDA_PATH', () => {
  it('BNCASmartScraper.findLightpandaBinary and LightPandaServer use the env override', async () => {
    const { BNCASmartScraper } = await import('../index.js');
    const { default: LightPandaServer } = await import('../lightpanda-server.js');
    const dir = await makeTempDir('bnca lp env ');
    const fake = path.join(dir, 'lightpanda');
    await fs.writeFile(fake, '#!/bin/sh\necho 1.0.1\n', { mode: 0o755 });
    const prev = process.env.LIGHTPANDA_PATH;
    process.env.LIGHTPANDA_PATH = fake;
    try {
      assert.equal(new BNCASmartScraper().findLightpandaBinary(), fake);
      assert.equal(new LightPandaServer().binaryPath, fake);
    } finally {
      if (prev === undefined) delete process.env.LIGHTPANDA_PATH; else process.env.LIGHTPANDA_PATH = prev;
      await removeDir(dir);
    }
  });
});
