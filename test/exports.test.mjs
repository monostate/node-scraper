import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pkg from '../index.js';

const EXPECTED = {
  // 2.x surface
  BNCASmartScraper: 'function', smartScrape: 'function', smartScreenshot: 'function', quickShot: 'function',
  askWebsiteAI: 'function', bulkScrape: 'function', bulkScrapeStream: 'function',
  BrowserSession: 'function', createSession: 'function',
  LightPandaServer: 'function', getLightPandaServer: 'function', stopLightPandaServer: 'function',
  ComputerUseProvider: 'function', LocalProvider: 'function',
  // 3.x additions
  BrowserPool: 'function', buildLaunchArgs: 'function',
  PoolClosedError: 'function', PoolQueueFullError: 'function', PoolAcquireTimeoutError: 'function', PoolAbortedError: 'function',
  Deadline: 'function', DeadlineError: 'function',
  CONTENT_STATUS: 'object', classifyContent: 'function', MIN_USABLE_TEXT_CHARS: 'number', SHELL_TEXT_CHARS: 'number', stripHtmlToText: 'function',
  findChromePath: 'function', checkCapabilities: 'function', CapabilityError: 'function',
  Trace: 'function',
  redactUrl: 'function', redactErrorMessage: 'function', isSensitiveField: 'function',
  normalizeXdoKey: 'function',
  LIGHTPANDA_VERSION: 'string', installLightpanda: 'function',
  ACTION_KIND: 'object',
};

describe('public exports', () => {
  for (const [name, type] of Object.entries(EXPECTED)) {
    it(`exports ${name} (${type})`, () => assert.equal(typeof pkg[name], type, `${name} is ${typeof pkg[name]}`));
  }
  it('default export is the scraper class', () => assert.equal(pkg.default, pkg.BNCASmartScraper));
  it('LIGHTPANDA_VERSION is 1.0.1', () => assert.equal(pkg.LIGHTPANDA_VERSION, '1.0.1'));
  it('getBrowserPoolStats reports the pool shape', () => {
    const stats = pkg.getBrowserPoolStats();
    assert.ok('poolSize' in stats && 'pending' in stats);
  });
});
