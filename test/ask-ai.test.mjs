import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { BNCASmartScraper } from '../index.js';

// A stand-in for OpenRouter / OpenAI / a custom endpoint; records every request.
async function startAiHost() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/aireply')) return res.end(JSON.stringify({ answer: 'endpoint says hi' }));
    res.end(JSON.stringify({ choices: [{ message: { content: 'model says hi' } }], model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(r => server.close(r)) };
}

describe('askAI', () => {
  let host, scraper, realFetch, fetched;
  before(async () => { host = await startAiHost(); });
  after(async () => { await host.close(); });
  beforeEach(() => {
    scraper = new BNCASmartScraper();
    scraper.scrape = async () => ({ success: true, method: 'direct-fetch', content: JSON.stringify({ title: 'T', content: 'Body text' }), stats: { totalTime: 1 }, performance: { totalTime: 1 } });
    fetched = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => { fetched.push(String(url)); return realFetch(url, init); };
  });
  afterEach(async () => { globalThis.fetch = realFetch; await scraper.cleanup(); });

  it('never contacts the retired hosted endpoint when only apiKey is given', async () => {
    const r = await scraper.askAI('https://x.test', 'q', { apiKey: 'legacy-key' });
    assert.equal(r.success, true);
    assert.equal(r.processing, 'local');
    assert.equal(fetched.some(u => u.includes('fly.dev')), false, JSON.stringify(fetched));
    assert.equal(fetched.length, 0, 'no network call at all');
  });

  it('posts to an explicit aiEndpoint with x-api-key', async () => {
    const r = await scraper.askAI('https://x.test', 'q', { aiEndpoint: `${host.base}/aireply`, aiApiKey: 'k1' });
    assert.equal(r.success, true);
    assert.equal(r.processing, 'endpoint');
    assert.equal(r.answer, 'endpoint says hi');
    const hit = host.hits.find(h => h.url === '/aireply');
    assert.equal(hit.headers['x-api-key'], 'k1');
    assert.deepEqual(hit.body, { url: 'https://x.test', question: 'q' });
  });

  it('reports token usage from OpenRouter-compatible responses', async () => {
    const r = await scraper.askAI('https://x.test', 'q', { openRouterApiKey: 'or', openRouterBaseUrl: host.base });
    assert.equal(r.processing, 'openrouter');
    assert.equal(r.answer, 'model says hi');
    assert.deepEqual(r.usage, { provider: 'openrouter', model: 'test-model', inputTokens: 10, outputTokens: 5 });
    assert.ok(r.trace && r.trace.usage.inputTokens === 10);
  });

  it('reports token usage from OpenAI-compatible responses', async () => {
    const r = await scraper.askAI('https://x.test', 'q', { openAIApiKey: 'oa', openAIBaseUrl: host.base });
    assert.equal(r.processing, 'openai');
    assert.deepEqual(r.usage, { provider: 'openai', model: 'test-model', inputTokens: 10, outputTokens: 5 });
  });

  it('propagates a failed scrape', async () => {
    scraper.scrape = async () => ({ success: false, error: 'content_blocked', method: 'direct-fetch', contentStatus: 'blocked' });
    const r = await scraper.askAI('https://x.test', 'q');
    assert.equal(r.success, false);
    assert.match(r.error, /content_blocked/);
    assert.equal(r.contentStatus, 'blocked');
  });
});

describe('scrape trace emission', () => {
  it('emits one trace event per scrape', async () => {
    const scraper = new BNCASmartScraper();
    scraper.tryDirectFetch = async () => ({ success: true, transportSuccess: true, httpStatus: 200, html: '<p>' + 'words '.repeat(40) + '</p>', content: '{}' });
    const traces = [];
    scraper.on('trace', (t) => traces.push(t));
    await scraper.scrape('https://x.test/a');
    await scraper.scrape('https://x.test/b');
    assert.equal(traces.length, 2);
    assert.equal(traces[0].operation, 'scrape');
    assert.equal(traces[0].stages[0].name, 'direct-fetch');
    assert.equal(traces[0].outcome, 'ok');
    await scraper.cleanup();
  });
});
