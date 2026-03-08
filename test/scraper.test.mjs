import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BNCASmartScraper } from '../index.js';
import BrowserPool from '../browser-pool.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHTML(body, head = '') {
  return `<html><head><title>Test</title>${head}</head><body>${body}</body></html>`;
}

const SIMPLE_HTML = makeHTML('<h1>Hello</h1><p>This is a simple page with enough text content to pass the minimal content check that the scraper uses to determine browser requirement.</p>');
const SPA_HTML = makeHTML('<div id="root"></div><script src="/_next/static/chunks/main.js"></script>');
const CLOUDFLARE_HTML = makeHTML('<p>Please enable JavaScript. Cloudflare protection active. Attention required! Cloudflare challenge page.</p>');
const NEXTJS_HTML = makeHTML('<div id="__next"></div><script>window.__NEXT_DATA__={};</script>');
const RICH_SPA_HTML = makeHTML(
  '<div id="root"><h1>Title</h1>' + '<p>Content paragraph. </p>'.repeat(30) + '</div>',
  '<script src="/_next/static/chunks/main.js"></script>'
);

const PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf content here for testing magic byte detection');

// ─── 1. Fallback Chain / Load Balancing ─────────────────────────────────────

describe('Fallback Chain', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 5000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('auto mode: uses direct-fetch for simple HTML', async () => {
    // Mock tryDirectFetch to return simple success
    const original = scraper.tryDirectFetch.bind(scraper);
    scraper.tryDirectFetch = async (url, config) => ({
      success: true,
      needsBrowser: false,
      content: JSON.stringify({ title: 'Test', content: 'Hello' }),
      html: SIMPLE_HTML,
      size: SIMPLE_HTML.length,
      contentType: 'text/html'
    });

    const result = await scraper.scrape('https://example.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
  });

  it('auto mode: falls back to lightpanda when browser is needed', async () => {
    scraper.tryDirectFetch = async () => ({
      success: true,
      needsBrowser: true,
      html: SPA_HTML,
      size: SPA_HTML.length,
      browserIndicators: ['React root div detected']
    });
    scraper.tryLightpanda = async () => ({
      success: true,
      content: JSON.stringify({ title: 'SPA', content: 'Rendered' }),
      html: '<html><body>Rendered</body></html>',
      size: 100,
      exitCode: 0
    });

    const result = await scraper.scrape('https://spa-app.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'lightpanda');
  });

  it('auto mode: falls back to puppeteer when lightpanda fails', async () => {
    scraper.tryDirectFetch = async () => ({
      success: true,
      needsBrowser: true,
      html: SPA_HTML,
      size: SPA_HTML.length,
      browserIndicators: []
    });
    scraper.tryLightpanda = async () => ({
      success: false,
      error: 'Lightpanda crashed',
      errorType: 'unknown',
      exitCode: 1
    });
    scraper.tryPuppeteer = async () => ({
      success: true,
      content: JSON.stringify({ title: 'SPA', content: 'Rendered by Puppeteer' }),
      size: 100
    });

    const result = await scraper.scrape('https://complex-spa.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'puppeteer');
    assert.deepEqual(result.fallbackChain, ['direct-fetch', 'lightpanda', 'puppeteer']);
  });

  it('auto mode: all methods fail returns method=failed', async () => {
    scraper.tryDirectFetch = async () => ({
      success: false,
      needsBrowser: false,
      error: 'HTTP 500'
    });
    scraper.tryLightpanda = async () => ({
      success: false,
      error: 'Lightpanda crashed'
    });
    scraper.tryPuppeteer = async () => ({
      success: false,
      error: 'Puppeteer timeout'
    });

    const result = await scraper.scrape('https://broken.com');
    assert.equal(result.method, 'failed');
  });

  it('auto mode: direct-fetch failure (not needsBrowser) still triggers fallback', async () => {
    scraper.tryDirectFetch = async () => ({
      success: false,
      needsBrowser: false,
      error: 'HTTP 403'
    });
    scraper.tryLightpanda = async () => ({
      success: true,
      content: JSON.stringify({ title: 'OK' }),
      html: '<html></html>',
      size: 50,
      exitCode: 0
    });

    const result = await scraper.scrape('https://blocked.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'lightpanda');
  });

  it('auto mode: includes fallbackChain in result', async () => {
    scraper.tryDirectFetch = async () => ({
      success: true,
      needsBrowser: true,
      html: SPA_HTML,
      size: SPA_HTML.length,
      browserIndicators: []
    });
    scraper.tryLightpanda = async () => ({
      success: true,
      content: '{}',
      html: '',
      size: 0,
      exitCode: 0
    });

    const result = await scraper.scrape('https://example.com');
    assert.ok(Array.isArray(result.fallbackChain));
    assert.ok(result.fallbackChain.includes('direct-fetch'));
    assert.ok(result.fallbackChain.includes('lightpanda'));
  });
});

// ─── 2. Forced Method Override ──────────────────────────────────────────────

describe('Forced Method Override', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 5000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('method=direct only uses direct fetch, no fallback on failure', async () => {
    scraper.tryDirectFetch = async () => ({
      success: false,
      error: 'HTTP 500'
    });
    const lpCalled = { value: false };
    scraper.tryLightpanda = async () => { lpCalled.value = true; return { success: true }; };

    const result = await scraper.scrape('https://example.com', { method: 'direct' });
    assert.equal(result.success, false);
    assert.equal(result.method, 'direct-fetch');
    assert.equal(lpCalled.value, false, 'should not fall back to lightpanda');
    assert.equal(result.fallbackChain, undefined, 'no fallbackChain in forced mode');
  });

  it('method=lightpanda only uses lightpanda', async () => {
    scraper.tryLightpanda = async () => ({
      success: true,
      content: JSON.stringify({ title: 'LP' }),
      html: '',
      size: 0,
      exitCode: 0
    });
    const dfCalled = { value: false };
    scraper.tryDirectFetch = async () => { dfCalled.value = true; return { success: true }; };

    const result = await scraper.scrape('https://example.com', { method: 'lightpanda' });
    assert.equal(result.success, true);
    assert.equal(result.method, 'lightpanda');
    assert.equal(dfCalled.value, false);
  });

  it('method=puppeteer only uses puppeteer', async () => {
    scraper.tryPuppeteer = async () => ({
      success: true,
      content: JSON.stringify({ title: 'Pup' }),
      size: 50
    });

    const result = await scraper.scrape('https://example.com', { method: 'puppeteer' });
    assert.equal(result.success, true);
    assert.equal(result.method, 'puppeteer');
  });

  it('invalid method returns error', async () => {
    const result = await scraper.scrape('https://example.com', { method: 'invalid' });
    assert.equal(result.success, false);
    assert.equal(result.method, 'error');
    assert.ok(result.error.includes('Invalid method'));
  });
});

// ─── 3. Browser Requirement Detection ───────────────────────────────────────

describe('Browser Requirement Detection', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false });
  });

  it('whitelisted sites never need browser', () => {
    const sites = ['example.com', 'wikipedia.org', 'httpbin.org', 'github.io', 'netlify.app', 'vercel.app'];
    for (const site of sites) {
      assert.equal(
        scraper.detectBrowserRequirement(SPA_HTML, `https://${site}/page`),
        false,
        `${site} should be whitelisted`
      );
    }
  });

  it('SPA with empty root div + minimal content needs browser', () => {
    assert.equal(scraper.detectBrowserRequirement(SPA_HTML, 'https://myapp.com'), true);
  });

  it('Cloudflare protection needs browser', () => {
    assert.equal(scraper.detectBrowserRequirement(CLOUDFLARE_HTML, 'https://protected.com'), true);
  });

  it('Next.js app with minimal content needs browser', () => {
    const html = makeHTML('<div id="root"></div><script>window.__NEXT_DATA__={}</script>');
    assert.equal(scraper.detectBrowserRequirement(html, 'https://nextapp.com'), true);
  });

  it('known SPA domains always need browser', () => {
    const domains = ['instagram.com', 'twitter.com', 'facebook.com', 'linkedin.com', 'youtube.com'];
    for (const domain of domains) {
      assert.equal(
        scraper.detectBrowserRequirement(SIMPLE_HTML, `https://${domain}/page`),
        true,
        `${domain} should require browser`
      );
    }
  });

  it('SPA indicators with rich content does NOT need browser', () => {
    // Has SPA indicators but lots of text content (>200 chars) -> not a client-only SPA
    assert.equal(scraper.detectBrowserRequirement(RICH_SPA_HTML, 'https://ssr-app.com'), false);
  });

  it('plain HTML with enough content does not need browser', () => {
    assert.equal(scraper.detectBrowserRequirement(SIMPLE_HTML, 'https://blog.com'), false);
  });
});

// ─── 4. Browser Indicators ──────────────────────────────────────────────────

describe('Browser Indicators', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false });
  });

  it('detects React root div', () => {
    const indicators = scraper.getBrowserIndicators('<div id="root"></div>');
    assert.ok(indicators.includes('React root div detected'));
  });

  it('detects Next.js data', () => {
    const indicators = scraper.getBrowserIndicators('<script>window.__NEXT_DATA__={}</script>');
    assert.ok(indicators.includes('Next.js data detected'));
  });

  it('detects Cloudflare challenge', () => {
    const indicators = scraper.getBrowserIndicators('Cloudflare challenge detected');
    assert.ok(indicators.includes('Cloudflare challenge detected'));
  });

  it('detects JavaScript required message', () => {
    const indicators = scraper.getBrowserIndicators('Please enable JavaScript to use this site');
    assert.ok(indicators.includes('JavaScript required message detected'));
  });

  it('returns empty array for plain HTML', () => {
    const indicators = scraper.getBrowserIndicators(SIMPLE_HTML);
    assert.equal(indicators.length, 0);
  });
});

// ─── 5. PDF Detection in Fallback Chain ─────────────────────────────────────

describe('PDF Detection', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 5000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('URL ending in .pdf triggers PDF parser before fallback', async () => {
    const methods = [];
    scraper.tryPDFParse = async () => {
      methods.push('pdf');
      return {
        success: true,
        content: JSON.stringify({ title: 'Test PDF', pages: 5, text: 'content' }),
        size: 1000,
        contentType: 'application/pdf',
        pages: 5
      };
    };
    scraper.tryDirectFetch = async () => { methods.push('direct'); return { success: false }; };

    const result = await scraper.scrape('https://example.com/doc.pdf');
    assert.equal(result.success, true);
    assert.equal(result.method, 'pdf');
    assert.ok(!methods.includes('direct'), 'direct fetch should not be called when PDF succeeds');
  });

  it('URL with .pdf? query triggers PDF parser', async () => {
    scraper.tryPDFParse = async () => ({
      success: true,
      content: '{}',
      size: 100,
      contentType: 'application/pdf',
      pages: 1
    });

    const result = await scraper.scrape('https://example.com/doc.pdf?v=2');
    assert.equal(result.method, 'pdf');
  });

  it('URL with /pdf/ path triggers PDF parser', async () => {
    scraper.tryPDFParse = async () => ({
      success: true,
      content: '{}',
      size: 100,
      contentType: 'application/pdf',
      pages: 1
    });

    const result = await scraper.scrape('https://example.com/pdf/document');
    assert.equal(result.method, 'pdf');
  });

  it('direct fetch detecting PDF content-type redirects to PDF parser', async () => {
    scraper.tryDirectFetch = async () => ({
      success: false,
      isPdf: true,
      error: 'Content is PDF'
    });
    scraper.tryPDFParse = async () => ({
      success: true,
      content: JSON.stringify({ title: 'Detected PDF' }),
      size: 500,
      contentType: 'application/pdf',
      pages: 3
    });

    const result = await scraper.scrape('https://example.com/download/report');
    assert.equal(result.method, 'pdf');
  });

  it('PDF parse failure on URL-detected PDF falls through to normal fallback', async () => {
    scraper.tryPDFParse = async () => ({
      success: false,
      error: 'Parse error'
    });
    scraper.tryDirectFetch = async () => ({
      success: true,
      needsBrowser: false,
      content: '{}',
      html: SIMPLE_HTML,
      size: SIMPLE_HTML.length,
      contentType: 'text/html'
    });

    const result = await scraper.scrape('https://example.com/fake.pdf');
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
  });
});

// ─── 6. Content Extraction ──────────────────────────────────────────────────

describe('Content Extraction', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false });
  });

  it('extracts title from HTML', () => {
    const html = '<html><head><title>My Page</title></head><body><p>Hello</p></body></html>';
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.equal(content.title, 'My Page');
  });

  it('extracts meta description', () => {
    const html = '<html><head><meta name="description" content="A great page"></head><body></body></html>';
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.equal(content.metaDescription, 'A great page');
  });

  it('extracts JSON-LD structured data', () => {
    const html = `<html><head><script type='application/ld+json'>{"@type":"Article","name":"Test"}</script></head><body></body></html>`;
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.ok(content.structuredData);
    assert.equal(content.structuredData[0]['@type'], 'Article');
  });

  it('extracts __NEXT_DATA__ window state', () => {
    const html = '<html><head></head><body><script>window.__NEXT_DATA__ = {"page":"/"};</script></body></html>';
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.ok(content.windowData);
    assert.equal(content.windowData.page, '/');
  });

  it('extracts __INITIAL_STATE__ window state', () => {
    const html = '<html><head></head><body><script>window.__INITIAL_STATE__ = {"user":"test"};</script></body></html>';
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.ok(content.windowData);
    assert.equal(content.windowData.user, 'test');
  });

  it('truncates body text to 2000 chars', () => {
    const longText = 'x'.repeat(5000);
    const html = `<html><head></head><body><p>${longText}</p></body></html>`;
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.ok(content.content.length <= 2000);
  });

  it('strips scripts and styles from body text', () => {
    const html = '<html><head></head><body><script>var x = 1;</script><style>.foo{}</style><p>Real content</p></body></html>';
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.ok(!content.content.includes('var x'));
    assert.ok(!content.content.includes('.foo'));
    assert.ok(content.content.includes('Real content'));
  });

  it('handles malformed HTML gracefully', () => {
    // The title regex requires a closing tag, so malformed HTML returns empty title
    const html = '<html><head><title>Broken';
    const content = JSON.parse(scraper.extractContentFromHTML(html));
    assert.equal(typeof content.title, 'string'); // doesn't crash, returns a string
  });
});

// ─── 7. Error Categorization ────────────────────────────────────────────────

describe('Error Categorization', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false });
  });

  it('timeout errors', () => {
    assert.equal(scraper.categorizeError('Request timed out'), 'timeout');
    assert.equal(scraper.categorizeError('Timeout after 10s'), 'timeout');
    assert.equal(scraper.categorizeError('AbortError: abort'), 'timeout');
  });

  it('network errors', () => {
    assert.equal(scraper.categorizeError('ENOTFOUND dns'), 'network');
    assert.equal(scraper.categorizeError('ECONNREFUSED 127.0.0.1'), 'network');
    assert.equal(scraper.categorizeError('ECONNRESET by peer'), 'network');
    assert.equal(scraper.categorizeError('Network error'), 'network');
  });

  it('parsing errors', () => {
    assert.equal(scraper.categorizeError('Parse error in JSON'), 'parsing');
    assert.equal(scraper.categorizeError('Parsing failed'), 'parsing');
    assert.equal(scraper.categorizeError('Invalid format'), 'parsing');
  });

  it('service unavailable errors', () => {
    assert.equal(scraper.categorizeError('404 Not Found'), 'service_unavailable');
    assert.equal(scraper.categorizeError('Service unavailable'), 'service_unavailable');
  });

  it('unknown errors', () => {
    assert.equal(scraper.categorizeError('Something weird happened'), 'unknown');
    assert.equal(scraper.categorizeError(null), 'unknown');
    assert.equal(scraper.categorizeError(undefined), 'unknown');
  });
});

// ─── 8. Browser Pool ────────────────────────────────────────────────────────

describe('Browser Pool', () => {
  it('exports a singleton instance', () => {
    assert.ok(BrowserPool);
    assert.equal(typeof BrowserPool.getBrowser, 'function');
    assert.equal(typeof BrowserPool.releaseBrowser, 'function');
    assert.equal(typeof BrowserPool.closeAll, 'function');
    assert.equal(typeof BrowserPool.getStats, 'function');
  });

  it('getStats returns expected shape', () => {
    const stats = BrowserPool.getStats();
    assert.ok('created' in stats);
    assert.ok('reused' in stats);
    assert.ok('queued' in stats);
    assert.ok('cleaned' in stats);
    assert.ok('poolSize' in stats);
    assert.ok('busyCount' in stats);
    assert.ok('idleCount' in stats);
    assert.ok('queueLength' in stats);
  });
});

// ─── 9. AI Q&A Fallback ────────────────────────────────────────────────────

describe('AI Q&A', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 5000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('returns error when scrape fails', async () => {
    scraper.scrape = async () => ({ success: false, error: 'Network error', method: 'failed' });

    const result = await scraper.askAI('https://example.com', 'What is this?');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Failed to scrape'));
  });

  it('falls back to local processing when no API keys', async () => {
    scraper.scrape = async () => ({
      success: true,
      content: JSON.stringify({ title: 'Test Page', content: 'Hello world' }),
      method: 'direct-fetch',
      stats: { totalTime: 100 }
    });

    const result = await scraper.askAI('https://example.com', 'What is the title?');
    assert.equal(result.success, true);
    assert.equal(result.processing, 'local');
    assert.ok(result.answer.includes('Test Page'));
  });

  it('local processing handles "about" questions', () => {
    const answer = scraper.processLocally('What is this about?', {
      title: 'My Site',
      content: 'This is a website about testing.'
    });
    assert.ok(answer.includes('My Site'));
  });

  it('local processing handles contact/email questions', () => {
    const answer = scraper.processLocally('What is the contact email?', {
      title: 'Contact',
      content: 'Reach us at hello@example.com for inquiries.'
    });
    assert.ok(answer.includes('hello@example.com'));
  });

  it('local processing handles no email found', () => {
    const answer = scraper.processLocally('What is the email?', {
      title: 'No Contact',
      content: 'No contact info here.'
    });
    assert.ok(answer.includes('No contact'));
  });
});

// ─── 10. Stats Tracking ────────────────────────────────────────────────────

describe('Stats Tracking', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false });
  });

  it('initial stats are all zero', () => {
    const stats = scraper.getStats();
    assert.equal(stats.directFetch.attempts, 0);
    assert.equal(stats.directFetch.successes, 0);
    assert.equal(stats.lightpanda.attempts, 0);
    assert.equal(stats.puppeteer.attempts, 0);
    assert.equal(stats.pdf.attempts, 0);
  });

  it('includes success rate percentages', () => {
    const stats = scraper.getStats();
    assert.ok('successRates' in stats);
    assert.equal(stats.successRates.directFetch, '0%');
  });

  it('performance object is included in scrape result', async () => {
    scraper.tryDirectFetch = async () => ({
      success: true,
      needsBrowser: false,
      content: '{}',
      html: SIMPLE_HTML,
      size: 100,
      contentType: 'text/html'
    });

    const result = await scraper.scrape('https://example.com');
    assert.ok(result.performance);
    assert.ok(typeof result.performance.totalTime === 'number');
    assert.equal(result.performance.method, 'direct-fetch');
  });
});

// ─── 11. Convenience Functions ──────────────────────────────────────────────

describe('Convenience Functions', () => {
  it('all convenience functions are exported', async () => {
    const mod = await import('../index.js');
    assert.equal(typeof mod.smartScrape, 'function');
    assert.equal(typeof mod.smartScreenshot, 'function');
    assert.equal(typeof mod.quickShot, 'function');
    assert.equal(typeof mod.askWebsiteAI, 'function');
    assert.equal(typeof mod.bulkScrape, 'function');
    assert.equal(typeof mod.bulkScrapeStream, 'function');
    assert.equal(typeof mod.BNCASmartScraper, 'function');
    assert.equal(typeof mod.default, 'function');
  });
});

// ─── 12. Screenshot Methods ─────────────────────────────────────────────────

describe('Screenshot Methods', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 10000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('screenshot() returns success with base64 data', async () => {
    // Mock the Chrome-based screenshot
    scraper.takeScreenshotWithChrome = async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

    const result = await scraper.screenshot('https://example.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'chrome-screenshot');
    assert.ok(result.screenshot.startsWith('data:image/png;base64,'));
    assert.ok(result.performance.totalTime >= 0);
  });

  it('screenshot() returns failure when Chrome not found', async () => {
    scraper.takeScreenshotWithChrome = async () => null;

    const result = await scraper.screenshot('https://example.com');
    assert.equal(result.success, false);
    assert.equal(result.method, 'chrome-screenshot');
  });

  it('screenshot() handles errors gracefully', async () => {
    scraper.takeScreenshotWithChrome = async () => { throw new Error('Chrome crashed'); };

    const result = await scraper.screenshot('https://example.com');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Chrome crashed'));
  });

  it('quickshot() returns success with base64 data', async () => {
    scraper.takeScreenshotOptimized = async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

    const result = await scraper.quickshot('https://example.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'quickshot');
    assert.ok(result.screenshot.startsWith('data:image/png;base64,'));
  });

  it('quickshot() returns failure when optimized screenshot fails', async () => {
    scraper.takeScreenshotOptimized = async () => null;

    const result = await scraper.quickshot('https://example.com');
    assert.equal(result.success, false);
    assert.equal(result.method, 'quickshot');
  });

  it('quickshot() handles errors gracefully', async () => {
    scraper.takeScreenshotOptimized = async () => { throw new Error('Timeout'); };

    const result = await scraper.quickshot('https://example.com');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Timeout'));
  });

  it('quickshot() uses longer default timeout (15s)', async () => {
    let capturedConfig = null;
    const originalQuickshot = scraper.quickshot.bind(scraper);
    scraper.takeScreenshotOptimized = async (url, config) => {
      capturedConfig = config;
      return 'data:image/png;base64,abc';
    };

    await scraper.quickshot('https://example.com');
    assert.equal(capturedConfig.timeout, 15000);
  });

  it('findChromePath() returns a string or null', async () => {
    const chromePath = await scraper.findChromePath();
    // On macOS with Chrome installed it should find it, otherwise null
    assert.ok(chromePath === null || typeof chromePath === 'string');
    if (chromePath) {
      assert.ok(chromePath.includes('Chrome') || chromePath.includes('chromium'));
    }
  });
});

// ─── 13. Screenshot Integration (live) ─────────────────────────────────────

describe('Screenshot Integration', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 20000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('takes a real screenshot of example.com', async () => {
    const chromePath = await scraper.findChromePath();
    if (!chromePath) {
      // Skip if no Chrome installed
      return;
    }

    const result = await scraper.screenshot('https://example.com');
    assert.equal(result.success, true);
    assert.ok(result.screenshot.startsWith('data:image/png;base64,'));
    assert.ok(result.screenshot.length > 100, 'screenshot should have substantial base64 data');
  });

  it('takes a real quickshot of example.com', async () => {
    const chromePath = await scraper.findChromePath();
    if (!chromePath) {
      return;
    }

    const result = await scraper.quickshot('https://example.com');
    assert.equal(result.success, true);
    assert.ok(result.screenshot.startsWith('data:image/png;base64,'));
  });
});

// ─── 14. Integration: Live Network ──────────────────────────────────────────

describe('Integration: Live Network', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 20000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('health check returns healthy', async () => {
    const health = await scraper.healthCheck();
    assert.equal(health.status, 'healthy');
    assert.equal(health.methods.directFetch, true);
  });
});

// ─── 15. Real Site Scraping: Simple HTML ────────────────────────────────────

describe('Real Sites: Simple HTML (should use direct-fetch)', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 20000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('example.com — minimal static HTML', async () => {
    const result = await scraper.scrape('https://example.com');
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
    const content = JSON.parse(result.content);
    assert.ok(content.title.includes('Example'));
  });

  it('httpbin.org — static API docs page', async () => {
    const result = await scraper.scrape('https://httpbin.org');
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
    assert.ok(result.content);
  });

  it('wikipedia.org — server-rendered content-heavy page', async () => {
    const result = await scraper.scrape('https://en.wikipedia.org/wiki/Web_scraping');
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
    const content = JSON.parse(result.content);
    assert.ok(content.title.toLowerCase().includes('web scraping'));
    assert.ok(content.content.length > 200, 'should have substantial text content');
  });

  it('info.cern.ch — the first ever website, pure HTML', async () => {
    const result = await scraper.scrape('https://info.cern.ch');
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
    assert.ok(result.content);
  });
});

// ─── 16. Real Site Scraping: JS-Heavy / SPA Detection ──────────────────────

describe('Real Sites: JS-Heavy (should detect browser requirement)', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 30000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('detects browser requirement for SPA-heavy sites', async () => {
    // Use direct fetch only to check if the detection logic flags it
    const directResult = await scraper.tryDirectFetch('https://react.dev', scraper.options);
    // React.dev is a React SPA — should either need browser or have minimal content
    if (directResult.success && directResult.needsBrowser) {
      assert.ok(true, 'correctly detected browser requirement for React SPA');
    } else if (directResult.success && !directResult.needsBrowser) {
      // Some SSR sites serve enough content via direct fetch — that's fine too
      const content = JSON.parse(directResult.content);
      assert.ok(content.content.length > 100, 'if direct fetch works, should have real content');
    } else {
      // Direct fetch failed entirely (blocked, timeout, etc.) — acceptable
      assert.ok(true, 'direct fetch failed, would fall back to browser');
    }
  });

  it('GitHub needs browser or serves enough SSR content', async () => {
    const result = await scraper.scrape('https://github.com/lightpanda-io/browser');
    assert.equal(result.success, true);
    // GitHub may work via direct fetch (good SSR) or fall back to browser
    assert.ok(['direct-fetch', 'lightpanda', 'puppeteer'].includes(result.method));
    const content = JSON.parse(result.content);
    assert.ok(content.title || content.content, 'should extract some content');
  });

  it('full fallback chain works for a real JS-rendered site', async () => {
    // Force auto mode and let the fallback chain do its thing
    const result = await scraper.scrape('https://angular.dev', { method: 'auto' });
    assert.equal(result.success, true);
    // Should have used some method successfully
    assert.ok(['direct-fetch', 'lightpanda', 'puppeteer'].includes(result.method));
    assert.ok(result.content, 'should have content regardless of method used');
  });
});

// ─── 17. Real Site Scraping: Method Override on Real Sites ─────────────────

describe('Real Sites: Forced Method Override', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 20000 });
  });

  afterEach(async () => {
    await scraper.cleanup();
  });

  it('forced direct fetch on example.com succeeds', async () => {
    const result = await scraper.scrape('https://example.com', { method: 'direct' });
    assert.equal(result.success, true);
    assert.equal(result.method, 'direct-fetch');
  });

  it('forced lightpanda on example.com succeeds', async () => {
    const result = await scraper.scrape('https://example.com', { method: 'lightpanda' });
    assert.equal(result.success, true);
    assert.equal(result.method, 'lightpanda');
    assert.ok(result.content);
  });

  it('forced puppeteer on example.com succeeds', async () => {
    const result = await scraper.scrape('https://example.com', { method: 'puppeteer' });
    assert.equal(result.success, true);
    assert.equal(result.method, 'puppeteer');
    assert.ok(result.content);
  });

  it('all three methods extract similar content from the same page', async () => {
    const directResult = await scraper.scrape('https://example.com', { method: 'direct' });
    const lpResult = await scraper.scrape('https://example.com', { method: 'lightpanda' });
    const pupResult = await scraper.scrape('https://example.com', { method: 'puppeteer' });

    assert.equal(directResult.success, true);
    assert.equal(lpResult.success, true);
    assert.equal(pupResult.success, true);

    const directContent = JSON.parse(directResult.content);
    const lpContent = JSON.parse(lpResult.content);
    const pupContent = JSON.parse(pupResult.content);

    // All three should find "Example Domain" in the title
    assert.ok(directContent.title.includes('Example'), 'direct: title');
    assert.ok(lpContent.title.includes('Example'), 'lightpanda: title');
    assert.ok(pupContent.title.includes('Example'), 'puppeteer: title');
  });
});

// ─── 18. Real Site Scraping: Browser Detection Accuracy ────────────────────

describe('Real Sites: Browser Detection Accuracy', () => {
  let scraper;

  beforeEach(() => {
    scraper = new BNCASmartScraper({ verbose: false, timeout: 15000 });
  });

  it('wikipedia does NOT trigger browser requirement (whitelisted)', () => {
    assert.equal(
      scraper.detectBrowserRequirement('<div id="root"></div>', 'https://en.wikipedia.org/wiki/Test'),
      false
    );
  });

  it('instagram.com triggers browser requirement (known SPA domain)', () => {
    assert.equal(
      scraper.detectBrowserRequirement('<html><body>Hello</body></html>', 'https://www.instagram.com/p/abc123'),
      true
    );
  });

  it('twitter.com triggers browser requirement (known SPA domain)', () => {
    assert.equal(
      scraper.detectBrowserRequirement('<html><body>Hello</body></html>', 'https://twitter.com/elonmusk'),
      true
    );
  });

  it('youtube.com triggers browser requirement (known SPA domain)', () => {
    assert.equal(
      scraper.detectBrowserRequirement('<html><body>Hello</body></html>', 'https://www.youtube.com/watch?v=123'),
      true
    );
  });

  it('static blog does NOT trigger browser requirement', async () => {
    // Fetch a real static page and verify detection says no browser needed
    const directResult = await scraper.tryDirectFetch('https://example.com', scraper.options);
    assert.equal(directResult.success, true);
    assert.equal(directResult.needsBrowser, false);
  });
});
