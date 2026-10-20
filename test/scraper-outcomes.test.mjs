import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BNCASmartScraper, CONTENT_STATUS } from '../index.js';
import { startFixtureServer } from './fixtures/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lpAvailable = fs.existsSync(path.join(here, '..', 'bin', 'lightpanda'));
let chromeAvailable = true;
try { await import('puppeteer'); } catch { chromeAvailable = false; }

describe('truthful scrape outcomes (direct fetch)', { timeout: 60000 }, () => {
  let fx, scraper;
  before(async () => { fx = await startFixtureServer(); scraper = new BNCASmartScraper({ timeout: 5000 }); });
  after(async () => { await scraper.cleanup(); await fx.close(); });

  it('exports CONTENT_STATUS', () => assert.equal(CONTENT_STATUS.USABLE, 'usable'));

  it('a 200 with an empty body is not a success', async () => {
    const r = await scraper.scrape(`${fx.url}/status/empty`, { method: 'direct' });
    assert.equal(r.success, false);
    assert.equal(r.transportSuccess, true);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.contentStatus, 'empty');
    assert.equal(r.engine, 'direct-fetch');
    assert.equal(r.error, 'content_empty');
    assert.equal(typeof r.textLength, 'number');
  });

  it('a 403 Access Denied page is blocked', async () => {
    const r = await scraper.scrape(`${fx.url}/status/forbidden`, { method: 'direct' });
    assert.equal(r.success, false);
    assert.equal(r.transportSuccess, true);
    assert.equal(r.httpStatus, 403);
    assert.equal(r.contentStatus, 'blocked');
    assert.ok(r.contentReasons.includes('http_403'));
    assert.ok(typeof r.html === 'string' && r.html.includes('Access Denied'), 'html kept for inspection');
  });

  it('a 200 challenge page is blocked', async () => {
    const r = await scraper.scrape(`${fx.url}/status/challenge`, { method: 'direct' });
    assert.equal(r.success, false);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.contentStatus, 'blocked');
    assert.ok(r.contentReasons.some(x => x.startsWith('challenge:')));
  });

  it('follows redirects and reports the chain and final URL', async () => {
    const r = await scraper.scrape(`${fx.url}/status/redirect`, { method: 'direct' });
    assert.equal(r.success, true);
    assert.equal(r.contentStatus, 'usable');
    assert.equal(r.httpStatus, 200);
    assert.ok(r.finalUrl.endsWith('/content'));
    assert.deepEqual(r.redirectChain.map(h => h.status), [302, 301]);
    assert.ok(r.redirectChain[0].url.endsWith('/status/redirect'));
  });

  it('a 404 is a navigation_error with the status preserved', async () => {
    const r = await scraper.scrape(`${fx.url}/nope`, { method: 'direct' });
    assert.equal(r.success, false);
    assert.equal(r.httpStatus, 404);
    assert.equal(r.contentStatus, 'navigation_error');
    assert.ok(r.contentReasons.includes('http_404'));
  });

  it('a connection failure is a navigation_error without transport success', async () => {
    const r = await scraper.scrape('http://127.0.0.1:1/', { method: 'direct' });
    assert.equal(r.success, false);
    assert.equal(r.transportSuccess, false);
    assert.equal(r.contentStatus, 'navigation_error');
    assert.equal(r.httpStatus, null);
  });

  it('auto mode treats a shell as a reason to try a browser engine', async () => {
    const s = new BNCASmartScraper({ timeout: 5000 });
    s.tryLightpanda = async () => ({ success: true, transportSuccess: true, httpStatus: 200, html: '<p>' + 'rendered '.repeat(40) + '</p>', content: '{}', finalUrl: 'x', redirectChain: [] });
    const r = await s.scrape(`${fx.url}/status/shell`);
    assert.deepEqual(r.fallbackChain, ['direct-fetch', 'lightpanda']);
    assert.equal(r.method, 'lightpanda');
    assert.equal(r.success, true);
    await s.cleanup();
  });

  it('auto mode retries a blocked direct fetch with a browser engine once', async () => {
    const s = new BNCASmartScraper({ timeout: 5000 });
    let lpCalls = 0;
    s.tryLightpanda = async () => { lpCalls++; return { success: true, transportSuccess: true, httpStatus: 200, html: '<p>' + 'ok '.repeat(60) + '</p>', content: '{}', finalUrl: 'x', redirectChain: [] }; };
    const r = await s.scrape(`${fx.url}/status/forbidden`);
    assert.equal(lpCalls, 1);
    assert.equal(r.success, true);
    assert.equal(r.method, 'lightpanda');
    await s.cleanup();
  });

  it('acceptContent lets the caller reject content without business logic in the library', async () => {
    const r = await scraper.scrape(`${fx.url}/content`, { method: 'direct', acceptContent: ({ text }) => (text.includes('unicorn') ? true : 'no unicorn') });
    assert.equal(r.success, false);
    assert.equal(r.contentStatus, 'rejected_by_caller');
    assert.deepEqual(r.contentReasons, ['no unicorn']);
    const ok = await scraper.scrape(`${fx.url}/content`, { method: 'direct', acceptContent: () => true });
    assert.equal(ok.success, true);
  });

  it('results carry a redacted execution trace', async () => {
    const r = await scraper.scrape(`${fx.url}/content?token=SECRET`, { method: 'direct' });
    assert.ok(r.trace && Array.isArray(r.trace.stages));
    assert.equal(r.trace.stages[0].name, 'direct-fetch');
    assert.equal(r.trace.stages[0].httpStatus, 200);
    assert.doesNotMatch(JSON.stringify(r.trace), /SECRET/);
  });
});

describe('truthful scrape outcomes (Lightpanda)', { timeout: 60000, skip: !lpAvailable && 'LightPanda not installed' }, () => {
  let fx, scraper;
  before(async () => { fx = await startFixtureServer(); scraper = new BNCASmartScraper({ timeout: 10000 }); });
  after(async () => { await scraper.cleanup(); await fx.close(); });

  it('reports http status and engine for a usable page', async () => {
    const r = await scraper.scrape(`${fx.url}/content`, { method: 'lightpanda' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.engine, 'lightpanda');
    assert.equal(r.httpStatus, 200);
    assert.equal(r.contentStatus, 'usable');
    assert.ok(r.finalUrl.endsWith('/content'));
  });

  it('reports a 403 as blocked', async () => {
    const r = await scraper.scrape(`${fx.url}/status/forbidden`, { method: 'lightpanda' });
    assert.equal(r.success, false);
    assert.equal(r.httpStatus, 403);
    assert.equal(r.contentStatus, 'blocked');
  });

  it('renders the JS-only form page as usable', async () => {
    const r = await scraper.scrape(`${fx.url}/forms/js`, { method: 'lightpanda' });
    assert.equal(r.success, true, r.error);
    assert.match(r.html, /id="submit"/);
  });
});

describe('truthful scrape outcomes (Puppeteer)', { timeout: 60000, skip: !chromeAvailable && 'Puppeteer not installed' }, () => {
  let fx, scraper;
  before(async () => { fx = await startFixtureServer(); scraper = new BNCASmartScraper({ timeout: 15000 }); });
  after(async () => { await scraper.cleanup(); await fx.close(); });

  it('reports the redirect chain, final URL and status', async () => {
    const r = await scraper.scrape(`${fx.url}/status/redirect`, { method: 'puppeteer' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.engine, 'puppeteer');
    assert.equal(r.httpStatus, 200);
    assert.ok(r.finalUrl.endsWith('/content'));
    assert.equal(r.redirectChain.length, 2);
  });

  it('reports a 403 as blocked', async () => {
    const r = await scraper.scrape(`${fx.url}/status/forbidden`, { method: 'puppeteer' });
    assert.equal(r.success, false);
    assert.equal(r.httpStatus, 403);
    assert.equal(r.contentStatus, 'blocked');
  });
});
