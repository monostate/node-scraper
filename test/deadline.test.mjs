import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Deadline, DeadlineError } from '../deadline.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('Deadline', () => {
  it('is unbounded by default', () => {
    const d = new Deadline();
    assert.equal(d.remaining(), Infinity);
    assert.equal(d.expired(), false);
    assert.equal(d.reason(), null);
    assert.equal(d.stageTimeout(5000), 5000);
    d.dispose();
  });

  it('expires after totalMs with reason timeout and an aborted signal', async () => {
    const d = Deadline.from(50);
    assert.ok(d.stageTimeout(10000) <= 50);
    assert.ok(d.remaining() <= 50 && d.remaining() > 0);
    await sleep(70);
    assert.equal(d.expired(), true);
    assert.equal(d.reason(), 'timeout');
    assert.equal(d.signal.aborted, true);
    assert.equal(d.remaining(), 0);
    assert.throws(() => d.throwIfExpired(), (e) => e instanceof DeadlineError && e.code === 'DEADLINE_EXCEEDED');
    d.dispose();
  });

  it('forwards a parent abort with reason aborted', () => {
    const ac = new AbortController();
    const d = Deadline.from({ totalMs: 10000, signal: ac.signal });
    ac.abort();
    assert.equal(d.expired(), true);
    assert.equal(d.reason(), 'aborted');
    assert.throws(() => d.throwIfExpired(), (e) => e.code === 'ABORTED');
    d.dispose();
  });

  it('from() accepts a Deadline, a number, an object or undefined', () => {
    const base = new Deadline({ totalMs: 1000 });
    assert.equal(Deadline.from(base), base);
    assert.ok(Deadline.from(200).remaining() <= 200);
    assert.equal(Deadline.from(undefined).remaining(), Infinity);
    assert.equal(Deadline.from({}).remaining(), Infinity);
    base.dispose();
  });

  it('child() is bounded by maxMs and by the parent', async () => {
    const parent = Deadline.from(1000);
    const child = parent.child(10);
    assert.ok(child.remaining() <= 10);
    const bigChild = parent.child(5000);
    assert.ok(bigChild.remaining() <= 1000);
    await sleep(20);
    assert.equal(child.expired(), true);
    assert.equal(bigChild.expired(), false);
    const ac = new AbortController();
    const p2 = Deadline.from({ signal: ac.signal });
    const c2 = p2.child(5000);
    ac.abort();
    assert.equal(c2.expired(), true);
    assert.equal(c2.reason(), 'aborted');
    parent.dispose(); p2.dispose();
  });

  it('stageTimeout never returns a negative number', async () => {
    const d = Deadline.from(5);
    await sleep(15);
    assert.equal(d.stageTimeout(1000), 0);
    d.dispose();
  });
});
