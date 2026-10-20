import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CHROME_CANDIDATES, findChromePath } from '../chrome-path.js';
import { makeTempDir, removeDir } from '../process-util.js';

describe('findChromePath', () => {
  it('prefers BNCA_CHROME_PATH when it points at an existing file', async () => {
    const dir = await makeTempDir('bnca-chrome-');
    const fake = path.join(dir, 'chrome');
    await fs.writeFile(fake, '#!/bin/sh\n'); await fs.chmod(fake, 0o755);
    assert.equal(await findChromePath({ env: { BNCA_CHROME_PATH: fake } }), fake);
    assert.equal(await findChromePath({ env: { PUPPETEER_EXECUTABLE_PATH: fake } }), fake);
    assert.equal(await findChromePath({ env: { CHROME_PATH: fake } }), fake);
    await removeDir(dir);
  });

  it('ignores env paths that do not exist and falls through to candidates', async () => {
    const dir = await makeTempDir('bnca-chrome-');
    const fake = path.join(dir, 'chromium');
    await fs.writeFile(fake, ''); await fs.chmod(fake, 0o755);
    const found = await findChromePath({
      env: { BNCA_CHROME_PATH: path.join(dir, 'missing') },
      candidates: { [process.platform]: [fake] },
      which: async () => null,
    });
    assert.equal(found, fake);
    await removeDir(dir);
  });

  it('returns null when nothing is found', async () => {
    const found = await findChromePath({ env: {}, candidates: { [process.platform]: [] }, which: async () => null });
    assert.equal(found, null);
  });

  it('exposes candidate lists per platform', () => {
    assert.ok(Array.isArray(CHROME_CANDIDATES.darwin) && CHROME_CANDIDATES.darwin.length > 0);
    assert.ok(CHROME_CANDIDATES.linux.includes('/usr/bin/chromium'));
  });
});

describe('BNCASmartScraper.findChromePath', () => {
  it('delegates to the shared finder (honours BNCA_CHROME_PATH)', async () => {
    const { BNCASmartScraper } = await import('../index.js');
    const dir = await makeTempDir('bnca-chrome-');
    const fake = path.join(dir, 'chrome');
    await fs.writeFile(fake, ''); await fs.chmod(fake, 0o755);
    const prev = process.env.BNCA_CHROME_PATH;
    process.env.BNCA_CHROME_PATH = fake;
    try {
      assert.equal(await new BNCASmartScraper().findChromePath(), fake);
    } finally {
      if (prev === undefined) delete process.env.BNCA_CHROME_PATH; else process.env.BNCA_CHROME_PATH = prev;
      await removeDir(dir);
    }
  });
});
