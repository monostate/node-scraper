import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Trace } from '../telemetry.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('Trace', () => {
  it('records stages with durations and an overall outcome', async () => {
    const trace = new Trace({ operation: 'scrape', url: 'http://x.test/?token=T' });
    const s1 = trace.stage('direct-fetch', { engine: 'http' });
    await sleep(5);
    s1.end({ outcome: 'error', reason: 'needs_browser', httpStatus: 200, bytesIn: 1234 });
    const s2 = trace.stage('lightpanda', { engine: 'lightpanda' });
    s2.end({ outcome: 'ok', httpStatus: 200, bytesIn: 5000, attempts: 1 });
    const rec = trace.finish({ outcome: 'ok' });
    assert.equal(rec.operation, 'scrape');
    assert.match(rec.id, /^[0-9a-f-]{36}$/);
    assert.equal(rec.url, 'http://x.test/?token=%5Bredacted%5D');
    assert.equal(rec.stages.length, 2);
    assert.equal(rec.stages[0].name, 'direct-fetch');
    assert.equal(rec.stages[0].outcome, 'error');
    assert.equal(rec.stages[0].reason, 'needs_browser');
    assert.ok(rec.stages[0].durationMs >= 4);
    assert.equal(rec.stages[1].engine, 'lightpanda');
    assert.equal(rec.stages[1].attempts, 1);
    assert.equal(rec.outcome, 'ok');
    assert.ok(rec.durationMs >= rec.stages[0].durationMs);
    assert.match(rec.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(trace.toJSON(), rec);
  });

  it('redacts sensitive keys and secrets inside event data and errors', () => {
    const trace = new Trace({ operation: 'session' });
    trace.event('type', { selector: '#pw', text: 'secret', value: 'v', cookies: [{ a: 1 }], note: 'see https://h/?key=K1' });
    const s = trace.stage('puppeteer');
    s.end({ outcome: 'error', error: new Error('boom at https://h/?token=T2 password=p3') });
    const rec = trace.finish({ outcome: 'error' });
    const ev = rec.events[0];
    assert.equal(ev.type, 'type');
    assert.equal(ev.selector, '#pw');
    assert.equal(ev.text, '[redacted]');
    assert.equal(ev.value, '[redacted]');
    assert.equal(ev.cookies, '[redacted]');
    assert.doesNotMatch(ev.note, /K1/);
    assert.doesNotMatch(rec.stages[0].error, /T2|p3/);
    assert.match(rec.stages[0].error, /^boom at/);
    assert.ok(typeof ev.at === 'number');
  });

  it('keeps raw data when redact is false', () => {
    const trace = new Trace({ operation: 'x', redact: false });
    trace.event('type', { text: 'plain' });
    assert.equal(trace.finish().events[0].text, 'plain');
  });

  it('infers the outcome from stages when finish() gets none and records usage', () => {
    const t1 = new Trace({ operation: 'a' });
    t1.stage('s').end({ outcome: 'fallback' });
    t1.stage('t').end({ outcome: 'ok' });
    assert.equal(t1.finish().outcome, 'fallback');
    const t2 = new Trace({ operation: 'b' });
    t2.stage('s').end({ outcome: 'cancelled' });
    assert.equal(t2.finish().outcome, 'cancelled');
    const t3 = new Trace({ operation: 'c' });
    t3.setUsage({ provider: 'openrouter', model: 'm', inputTokens: 10, outputTokens: 5 });
    assert.deepEqual(t3.finish().usage, { provider: 'openrouter', model: 'm', inputTokens: 10, outputTokens: 5 });
  });

  it('ending a stage twice is a no-op and unended stages are closed by finish()', () => {
    const t = new Trace({ operation: 'd' });
    const s = t.stage('open');
    const a = s.end({ outcome: 'ok' });
    const b = s.end({ outcome: 'error' });
    assert.equal(a, b);
    const u = t.stage('unended');
    const rec = t.finish({ outcome: 'error' });
    assert.equal(rec.stages[1].outcome, 'error');
    assert.equal(rec.stages[1].reason, 'unfinished');
    assert.ok(u);
  });
});
