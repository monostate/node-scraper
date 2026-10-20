import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixtures/server.mjs';

describe('fixture server', () => {
  let fx;
  before(async () => { fx = await startFixtureServer(); });
  after(async () => { await fx.close(); });

  it('sets the qa-session cookie on HTML pages', async () => {
    const res = await fetch(`${fx.url}/forms/basic`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /qa-session=local-audit/);
    const html = await res.text();
    assert.match(html, /name="csrf" value="local-audit-token"/);
    assert.match(html, /id="submit"/);
  });

  it('accepts a POST with csrf token and session cookie', async () => {
    fx.reset();
    const res = await fetch(`${fx.url}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'qa-session=local-audit' },
      body: new URLSearchParams({ csrf: 'local-audit-token', name: 'A', email: 'a@example.invalid', country: 'UK', cover: 'x', consent: 'on' }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Test application received<\/title>/);
    assert.equal(fx.submissions.length, 1);
    assert.equal(fx.submissions[0].fields.name, 'A');
  });

  it('rejects a POST without the session cookie', async () => {
    fx.reset();
    const res = await fetch(`${fx.url}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'local-audit-token', name: 'A' }),
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Invalid session or CSRF token/);
    assert.equal(fx.submissions.length, 0);
  });

  it('records a submission then drops the connection on /submit-drop', async () => {
    fx.reset();
    await assert.rejects(() => fetch(`${fx.url}/submit-drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'qa-session=local-audit' },
      body: new URLSearchParams({ csrf: 'local-audit-token', name: 'B' }),
    }));
    assert.equal(fx.submissions.length, 1);
  });

  it('serves a two-hop redirect chain to /content', async () => {
    const r1 = await fetch(`${fx.url}/status/redirect`, { redirect: 'manual' });
    assert.equal(r1.status, 302);
    assert.equal(r1.headers.get('location'), '/status/redirect2');
    const r2 = await fetch(`${fx.url}/status/redirect2`, { redirect: 'manual' });
    assert.equal(r2.status, 301);
    assert.equal(r2.headers.get('location'), '/content');
    const r3 = await fetch(`${fx.url}/content`);
    const html = await r3.text();
    assert.ok(html.replace(/<[^>]+>/g, ' ').length > 500);
    assert.match(html, /application\/ld\+json/);
  });

  it('serves status fixtures', async () => {
    assert.equal((await fetch(`${fx.url}/status/forbidden`)).status, 403);
    const ch = await fetch(`${fx.url}/status/challenge`);
    assert.equal(ch.status, 200);
    assert.match(await ch.text(), /Just a moment/);
    const empty = await (await fetch(`${fx.url}/status/empty`)).text();
    assert.equal(empty.replace(/<[^>]+>/g, '').trim(), '');
    const shell = await (await fetch(`${fx.url}/status/shell`)).text();
    assert.match(shell, /<div id="root"><\/div>/);
  });

  it('serves a download with content-disposition', async () => {
    const res = await fetch(`${fx.url}/download`);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="report.txt"');
    assert.ok((await res.text()).length >= 2000);
  });

  it('serves /slow after the requested delay and /cookie-check echoes cookies', async () => {
    const t0 = Date.now();
    await fetch(`${fx.url}/slow?ms=200`);
    assert.ok(Date.now() - t0 >= 190);
    const res = await fetch(`${fx.url}/cookie-check`, { headers: { Cookie: 'a=1' } });
    assert.deepEqual(await res.json(), { cookie: 'a=1' });
  });

  it('serves interaction, frames, dialogs, password and many-controls pages', async () => {
    for (const [path, re] of [
      ['/interaction', /id="click-target"/],
      ['/frames', /<iframe name="inner"/],
      ['/frames/inner', /id="inner-btn"/],
      ['/dialogs', /id="prompt"/],
      ['/password', /type="password"/],
      ['/many-controls', /we!rd:id/],
      ['/forms/js', /getElementById\('app'\)/],
      ['/forms/full', /type="file"/],
    ]) {
      const html = await (await fetch(fx.url + path)).text();
      assert.match(html, re, path);
    }
    const many = await (await fetch(`${fx.url}/many-controls`)).text();
    assert.equal((many.match(/<button class="b"/g) || []).length, 120);
  });
});
