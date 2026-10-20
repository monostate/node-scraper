#!/usr/bin/env node
/**
 * Lightpanda installer — pinned, checksum-verified, atomic.
 *
 * Importable (used by tests and by `checkCapabilities`) and runnable as the
 * package postinstall hook. The postinstall never fails the npm install: it
 * prints one status line and exits 0. Set BNCA_SKIP_LIGHTPANDA_INSTALL=1 to
 * opt out, LIGHTPANDA_PATH to point the package at an existing binary.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const LIGHTPANDA_VERSION = '1.0.1';

/** SHA-256 of each 1.0.1 release asset (verified 2026-10-20). */
export const LIGHTPANDA_CHECKSUMS = Object.freeze({
  'lightpanda-aarch64-macos': 'd4b66ac8484f49d7a49e05b6f9342716c747129527fcbe8ffe36679ffa18dd60',
  'lightpanda-aarch64-linux': '392ba370c12d9f045c36c1477db8b3e2985942c89532732ef8d1610057db7d5c',
  'lightpanda-x86_64-linux': '551747e35c51ba107b5d5277eca4b48e077b2a3b40f09a047bf6670448bc35fd',
  'lightpanda-x86_64-macos': '1fcca0ae7684f470780de611a56e9a8ea612d5ff21e37dbb48905ebac5b918a7',
});

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_BIN_DIR = path.join(PACKAGE_DIR, 'bin');
export const BINARY_NAME = 'lightpanda';

function isWSL() {
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** @returns {string|null} release asset name for this platform, or null when unsupported */
export function assetNameFor({ platform = process.platform, arch = process.arch } = {}) {
  const archName = arch === 'arm64' || arch === 'aarch64' ? 'aarch64'
    : arch === 'x64' || arch === 'x86_64' ? 'x86_64'
      : null;
  if (!archName) return null;
  if (platform === 'darwin') return `lightpanda-${archName}-macos`;
  if (platform === 'linux') return `lightpanda-${archName}-linux`;
  if (platform === 'win32' && isWSL()) return `lightpanda-${archName}-linux`;
  return null;
}

export function downloadUrlFor(asset, version = LIGHTPANDA_VERSION) {
  return `https://github.com/lightpanda-io/browser/releases/download/${version}/${asset}`;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest('hex');
}

/**
 * Download `url` to `destPath` via a `.part-<pid>` temp file and an atomic rename.
 * Redirects are followed manually so they can be bounded.
 */
export async function download(url, destPath, { maxRedirects = 5, timeoutMs = 180000, fetchImpl = fetch, onProgress } = {}) {
  const partPath = `${destPath}.part-${process.pid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`download timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    let current = url;
    let response = null;
    for (let i = 0; i <= maxRedirects; i++) {
      response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get('location');
        if (!loc) throw new Error(`redirect without location from ${current}`);
        current = new URL(loc, current).toString();
        response = null;
        continue;
      }
      break;
    }
    if (!response) throw new Error(`too many redirects (>${maxRedirects}) downloading ${url}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${current}`);
    if (!response.body) throw new Error(`empty body downloading ${current}`);

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    const out = fs.createWriteStream(partPath, { mode: 0o755 });
    await pipeline(
      Readable.fromWeb(response.body, { signal: controller.signal }),
      async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          onProgress?.({ received, total });
          yield chunk;
        }
      },
      out,
    );
    await fsp.rename(partPath, destPath);
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('download aborted');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `<binary> version` and return the trimmed stdout (null on any failure). */
export function binaryVersion(binaryPath) {
  return new Promise((resolve) => {
    execFile(binaryPath, ['version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = `${stdout || ''}${stderr || ''}`.trim().split('\n')[0]?.trim();
      resolve(out || null);
    });
  });
}

/**
 * @returns {Promise<{ status: 'installed'|'present'|'skipped'|'unsupported'|'failed', path?: string, version?: string, reason?: string }>}
 */
export async function installLightpanda({
  binDir = DEFAULT_BIN_DIR,
  version = LIGHTPANDA_VERSION,
  force = false,
  skip = process.env.BNCA_SKIP_LIGHTPANDA_INSTALL === '1',
  platform = process.platform,
  arch = process.arch,
  checksums = LIGHTPANDA_CHECKSUMS,
  urlFor = (asset) => downloadUrlFor(asset, version),
  healthCheck = binaryVersion,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const binaryPath = path.join(binDir, BINARY_NAME);

  if (skip) {
    log('lightpanda: install skipped (BNCA_SKIP_LIGHTPANDA_INSTALL=1)');
    return { status: 'skipped', path: binaryPath, reason: 'BNCA_SKIP_LIGHTPANDA_INSTALL' };
  }

  const asset = assetNameFor({ platform, arch });
  if (!asset) {
    log(`lightpanda: no release asset for ${platform}/${arch}; Lightpanda disabled (Chrome fallback still works)`);
    return { status: 'unsupported', reason: `${platform}/${arch}` };
  }

  if (!force && fs.existsSync(binaryPath)) {
    const existing = await healthCheck(binaryPath);
    if (existing === version) {
      await fsp.chmod(binaryPath, 0o755).catch(() => {});
      log(`lightpanda: present ${binaryPath} (${version})`);
      return { status: 'present', path: binaryPath, version };
    }
    log(`lightpanda: existing binary reports ${existing ?? 'unknown'}; replacing with ${version}`);
  }

  const expected = checksums[asset];
  if (!expected) {
    return { status: 'failed', reason: `no checksum for ${asset}` };
  }

  const stagingPath = `${binaryPath}.download-${process.pid}`;
  try {
    const url = urlFor(asset);
    log(`lightpanda: downloading ${url}`);
    await download(url, stagingPath, { fetchImpl });

    const actual = await sha256File(stagingPath);
    if (actual !== expected) {
      await fsp.rm(stagingPath, { force: true });
      log(`lightpanda: checksum mismatch for ${asset} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
      return { status: 'failed', reason: 'checksum_mismatch', path: binaryPath };
    }

    await fsp.chmod(stagingPath, 0o755);
    const reported = await healthCheck(stagingPath);
    if (reported !== version) {
      await fsp.rm(stagingPath, { force: true });
      log(`lightpanda: health check failed (binary reports ${reported ?? 'nothing'}, expected ${version})`);
      return { status: 'failed', reason: 'health_check', path: binaryPath };
    }

    await fsp.rename(stagingPath, binaryPath);
    log(`lightpanda: installed ${binaryPath} (${version})`);
    return { status: 'installed', path: binaryPath, version };
  } catch (err) {
    await fsp.rm(stagingPath, { force: true }).catch(() => {});
    log(`lightpanda: install failed: ${err.message}`);
    return { status: 'failed', reason: err.message, path: binaryPath };
  }
}

// CLI / postinstall entry point
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const force = process.argv.includes('--force');
  installLightpanda({ force })
    .then((r) => {
      console.log(`lightpanda: ${r.status}${r.path ? ` ${r.path}` : ''}${r.reason ? ` (${r.reason})` : ''}`);
      if (r.status === 'failed') console.log('   The package will fall back to Chrome/Puppeteer for browser-based scraping.');
      process.exit(0);
    })
    .catch((err) => {
      console.error(`lightpanda: unexpected installer error: ${err.message}`);
      process.exit(0);
    });
}
