import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_STATUS, MIN_USABLE_TEXT_CHARS, SHELL_TEXT_CHARS, classifyContent, stripHtmlToText } from '../content-status.js';
import { startFixtureServer } from './fixtures/server.mjs';

describe('classifyContent', () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await fx.close(); });

  const fetchCase = async (p) => {
    const res = await fetch(fx.url + p);
    const html = await res.text();
    return classifyContent({ httpStatus: res.status, html, title: html.match(/<title>([^<]*)/)?.[1] });
  };

  it('constants are exported', () => {
    assert.equal(CONTENT_STATUS.USABLE, 'usable');
    assert.equal(CONTENT_STATUS.SHELL, 'browser_required_shell');
    assert.equal(MIN_USABLE_TEXT_CHARS, 50);
    assert.equal(SHELL_TEXT_CHARS, 200);
  });

  it('empty 200 body is empty', async () => {
    const r = await fetchCase('/status/empty');
    assert.equal(r.status, CONTENT_STATUS.EMPTY);
    assert.match(r.reasons[0], /^text_\d+_chars$/);
  });

  it('SPA shell is browser_required_shell', async () => {
    const r = await fetchCase('/status/shell');
    assert.equal(r.status, CONTENT_STATUS.SHELL);
    assert.ok(r.reasons.includes('spa_root_empty'));
  });

  it('403 Access Denied is blocked with http_403', async () => {
    const r = await fetchCase('/status/forbidden');
    assert.equal(r.status, CONTENT_STATUS.BLOCKED);
    assert.ok(r.reasons.includes('http_403'));
  });

  it('200 challenge page is blocked with a challenge reason', async () => {
    const r = await fetchCase('/status/challenge');
    assert.equal(r.status, CONTENT_STATUS.BLOCKED);
    assert.ok(r.reasons.some(x => x.startsWith('challenge:')));
  });

  it('404 with a short body is navigation_error', () => {
    const r = classifyContent({ httpStatus: 404, html: '<html><body><p>nope</p></body></html>' });
    assert.equal(r.status, CONTENT_STATUS.NAVIGATION_ERROR);
    assert.ok(r.reasons.includes('http_404'));
  });

  it('error without html is navigation_error', () => {
    const r = classifyContent({ error: 'ECONNREFUSED 127.0.0.1:1' });
    assert.equal(r.status, CONTENT_STATUS.NAVIGATION_ERROR);
    assert.match(r.reasons[0], /^error:/);
  });

  it('real article is usable', async () => {
    const r = await fetchCase('/content');
    assert.equal(r.status, CONTENT_STATUS.USABLE);
    assert.deepEqual(r.reasons, []);
  });

  it('accepts pre-extracted text instead of html', () => {
    const r = classifyContent({ httpStatus: 200, text: 'x'.repeat(300) });
    assert.equal(r.status, CONTENT_STATUS.USABLE);
  });

  it('stripHtmlToText drops scripts, styles and tags', () => {
    assert.equal(stripHtmlToText('<p>Hi <b>there</b></p><script>var a=1</script><style>p{}</style>'), 'Hi there');
  });
});
