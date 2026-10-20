/**
 * Shared Chrome/Chromium discovery.
 *
 * Order: explicit env (BNCA_CHROME_PATH, PUPPETEER_EXECUTABLE_PATH,
 * CHROME_PATH) → well-known per-platform paths → `which` on Linux.
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

export const CHROME_CANDIDATES = Object.freeze({
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  ],
});

const WHICH_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

const ENV_KEYS = ['BNCA_CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH'];

async function isFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function defaultWhich(name) {
  return new Promise((resolve) => {
    execFile('which', [name], { timeout: 3000 }, (err, stdout) => {
      resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0] : null);
    });
  });
}

/**
 * @param {{ env?: Record<string,string|undefined>, candidates?: Record<string,string[]>, platform?: string, which?: (name:string)=>Promise<string|null> }} [opts]
 * @returns {Promise<string|null>}
 */
export async function findChromePath({
  env = process.env,
  candidates = CHROME_CANDIDATES,
  platform = process.platform,
  which = defaultWhich,
} = {}) {
  for (const key of ENV_KEYS) {
    const p = env[key];
    if (p && await isFile(p)) return p;
  }
  for (const p of candidates[platform] || []) {
    if (await isFile(p)) return p;
  }
  if (platform === 'linux') {
    for (const name of WHICH_NAMES) {
      const p = await which(name);
      if (p && await isFile(p)) return p;
    }
  }
  return null;
}

export default findChromePath;
