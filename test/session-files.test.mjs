import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../browser-session.js';
import browserPool from '../browser-pool.js';
import { makeTempDir, removeDir } from '../process-util.js';
import { startFixtureServer } from './fixtures/server.mjs';

let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }
const skip = !chromeAvailable && 'Puppeteer not installed';
const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PDF = path.join(here, 'fixtures', 'mock.pdf');

async function fillBasic(s) {
  await s.type('#name', 'Upload Tester');
  await s.type('#email', 'qa@example.invalid');
  await s.select('#country', 'UK');
  await s.type('#cover', 'Controlled fixture only');
  await s.click('#consent', { waitForNavigation: false });
}

describe('uploads', { timeout: 60000, skip }, () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await browserPool.closeAll(); await fx.close(); });

  it('uploadFile() attaches a path and the multipart POST carries the PDF', async () => {
    fx.reset();
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/forms/full`);
    await fillBasic(s);
    const up = await s.uploadFile('#cv', [MOCK_PDF]);
    assert.equal(up.success, true);
    assert.equal(up.outcome, 'ok');
    assert.equal(up.files[0].name, 'mock.pdf');
    assert.ok(up.files[0].size > 0);
    const r = await s.click('#submit');
    assert.equal(r.outcome, 'ok');
    assert.equal(await s.evaluate(() => document.title), 'Test application received');
    await s.close();
    assert.equal(fx.submissions.length, 1);
    assert.equal(fx.submissions[0].hasPdf, true);
    assert.equal(fx.submissions[0].fields.cv, '<file:mock.pdf>');
  });

  it('uploadFile() accepts in-memory buffers with a filename and mime type', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/forms/full`);
    const data = await fs.readFile(MOCK_PDF);
    const up = await s.uploadFile('#cv', [{ name: 'memory.pdf', data, mimeType: 'application/pdf' }]);
    assert.equal(up.files[0].name, 'memory.pdf');
    const attached = await s.evaluate(() => Array.from(document.querySelector('#cv').files).map(f => f.name));
    assert.deepEqual(attached, ['memory.pdf']);
    const tmp = s._uploadDir;
    await s.close();
    await assert.rejects(() => fs.stat(tmp), 'temp upload dir removed on close');
  });

  it('uploadFile() enforces maxUploadBytes', async () => {
    const s = await createSession({ mode: 'chrome', maxUploadBytes: 10 });
    await s.goto(`${fx.url}/forms/full`);
    await assert.rejects(() => s.uploadFile('#cv', [MOCK_PDF]), /maxUploadBytes/);
    await s.close();
  });

  it('waitForFileChooser() intercepts a native picker opened by a click', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/forms/full`);
    const [chooser] = await Promise.all([
      s.waitForFileChooser({ timeout: 10000 }),
      s.click('#cv', { waitForNavigation: false }),
    ]);
    assert.equal(chooser.isMultiple, false);
    await chooser.accept([MOCK_PDF]);
    const attached = await s.evaluate(() => Array.from(document.querySelector('#cv').files).map(f => f.name));
    assert.deepEqual(attached, ['mock.pdf']);
    await s.close();
  });
});

describe('downloads', { timeout: 60000, skip }, () => {
  let fx, dir;
  before(async () => { fx = await startFixtureServer(); dir = await makeTempDir('bnca-dl-'); });
  after(async () => { await browserPool.closeAll(); await fx.close(); await removeDir(dir); });

  it('enableDownloads() + waitForDownload() deliver the file to the chosen directory', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/content`);
    await s.enableDownloads({ dir });
    const [dl] = await Promise.all([
      s.waitForDownload({ timeout: 15000 }),
      s.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.download = ''; document.body.appendChild(a); a.click(); }, `${fx.url}/download`),
    ]);
    assert.equal(dl.state, 'completed');
    assert.equal(dl.suggestedFilename, 'report.txt');
    assert.match(dl.url, /\/download$/);
    assert.equal(path.dirname(dl.path), dir);
    assert.equal(path.basename(dl.path), 'report.txt');
    const body = await fs.readFile(dl.path, 'utf8');
    assert.ok(body.startsWith('report line'));
    assert.ok(dl.receivedBytes > 0);
    assert.equal(s.downloads().length, 1);
    await s.close();
  });

  it('waitForDownload() rejects when nothing is downloaded in time', async () => {
    const s = await createSession({ mode: 'chrome' });
    await s.goto(`${fx.url}/content`);
    await s.enableDownloads({ dir });
    await assert.rejects(() => s.waitForDownload({ timeout: 300 }), /timed out/i);
    await s.close();
  });
});
