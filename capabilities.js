/**
 * Capability preflight: which engines and OS tools are present, which modes
 * that enables, and exactly what to install for the rest.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { findChromePath } from './chrome-path.js';

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const INSTALL_HINTS = Object.freeze({
  puppeteer: 'npm install puppeteer',
  chrome: 'apt-get install chromium (or set BNCA_CHROME_PATH)',
  lightpanda: 'node node_modules/@monostate/node-scraper/scripts/install-lightpanda.js',
  ws: 'npm install ws',
  xvfb: 'apt-get install xvfb',
  xdotool: 'apt-get install xdotool',
  x11vnc: 'apt-get install x11vnc',
  imagemagick: 'apt-get install imagemagick',
});

const TOOL_BINARIES = Object.freeze({
  xvfb: 'Xvfb',
  xdotool: 'xdotool',
  x11vnc: 'x11vnc',
  imagemagick: 'import',
});

export class CapabilityError extends Error {
  constructor(capability, install) {
    super(`missing capability "${capability}"${install ? ` — install with: ${install}` : ''}`);
    this.name = 'CapabilityError';
    this.code = 'CAPABILITY_MISSING';
    this.capability = capability;
    this.install = install || null;
  }
}

function run(exec, cmd, args) {
  return new Promise((resolve) => {
    exec(cmd, args, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim());
    });
  });
}

async function defaultFileExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function moduleInfo(name) {
  try {
    await import(name);
    let version = null;
    try { version = require(`${name}/package.json`).version; } catch { /* no package.json export */ }
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

/**
 * @param {{ lightpandaPath?: string, chromePath?: string, exec?: Function, platform?: string, fileExists?: (p:string)=>Promise<boolean>, env?: Record<string,string|undefined> }} [opts]
 */
export async function checkCapabilities({
  lightpandaPath,
  chromePath,
  exec = nodeExecFile,
  platform = process.platform,
  fileExists = defaultFileExists,
  env = process.env,
} = {}) {
  const report = {
    platform,
    arch: process.arch,
    node: process.version,
    puppeteer: await moduleInfo('puppeteer'),
    ws: await moduleInfo('ws'),
    chrome: { available: false, path: null },
    lightpanda: { available: false, path: null, version: null },
    xvfb: { available: false },
    xdotool: { available: false },
    x11vnc: { available: false },
    imagemagick: { available: false },
    modes: {},
    missing: [],
  };

  const chrome = chromePath || await findChromePath({ env, platform });
  if (chrome && await fileExists(chrome)) report.chrome = { available: true, path: chrome };

  const lp = lightpandaPath || env.LIGHTPANDA_PATH || path.join(PACKAGE_DIR, 'bin', 'lightpanda');
  if (lp && await fileExists(lp)) {
    const version = await run(exec, lp, ['version']);
    report.lightpanda = { available: true, path: lp, version: version ? version.split('\n')[0].trim() : null };
  } else {
    report.lightpanda = { available: false, path: lp || null, version: null };
  }

  const toolsRelevant = platform === 'linux';
  if (toolsRelevant) {
    for (const [cap, bin] of Object.entries(TOOL_BINARIES)) {
      const found = await run(exec, 'which', [bin]);
      report[cap] = { available: Boolean(found), path: found || null };
    }
  }

  const chromeMode = report.puppeteer.available && report.chrome.available;
  const computerUse = platform === 'linux' && report.chrome.available && report.xvfb.available && report.xdotool.available;
  report.modes = {
    http: true,
    lightpanda: report.lightpanda.available,
    chrome: chromeMode,
    visual: chromeMode && (platform !== 'linux' || Boolean(env.DISPLAY) || report.xvfb.available),
    computerUse,
    vnc: computerUse && report.x11vnc.available,
  };

  for (const cap of ['puppeteer', 'chrome', 'lightpanda', 'ws']) {
    if (!report[cap].available) report.missing.push({ capability: cap, install: INSTALL_HINTS[cap] });
  }
  if (toolsRelevant) {
    for (const cap of Object.keys(TOOL_BINARIES)) {
      if (!report[cap].available) report.missing.push({ capability: cap, install: INSTALL_HINTS[cap] });
    }
  }
  return report;
}

/** Throw a CapabilityError when `name` is not available in the report. */
export function requireCapability(report, name) {
  const entry = report?.[name];
  if (!entry || typeof entry.available !== 'boolean') throw new Error(`unknown capability "${name}"`);
  if (!entry.available) throw new CapabilityError(name, INSTALL_HINTS[name]);
}

export default checkCapabilities;
