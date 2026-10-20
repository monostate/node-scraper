import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerUseProvider } from '../computer-use-provider.js';

class RecordingProvider extends ComputerUseProvider {
  constructor() { super(); this.calls = []; }
  async mouseMove(x, y) { this.calls.push(['move', x, y]); return { success: true }; }
  async mouseDown(x, y, button = 'left') { this.calls.push(['down', x, y, button]); return { success: true }; }
  async mouseUp(button = 'left') { this.calls.push(['up', button]); return { success: true }; }
}

describe('ComputerUseProvider base contract', () => {
  it('default mouseDrag interpolates: move, down, N moves, up, with per-step delay', async () => {
    const p = new RecordingProvider();
    const t0 = Date.now();
    const r = await p.mouseDrag(0, 0, 120, 60, { steps: 12, stepDelayMs: 20, holdMs: 0 });
    const elapsed = Date.now() - t0;
    assert.equal(r.success, true);
    assert.deepEqual(p.calls[0], ['move', 0, 0]);
    assert.deepEqual(p.calls[1], ['down', 0, 0, 'left']);
    const moves = p.calls.slice(2, -1);
    assert.equal(moves.length, 12);
    assert.ok(moves.every(c => c[0] === 'move'));
    assert.deepEqual(moves.at(-1).slice(1), [120, 60], 'last step lands on the target');
    assert.ok(moves[0][1] > 0 && moves[0][1] < 120, 'first step is between start and end');
    assert.deepEqual(p.calls.at(-1), ['up', 'left']);
    assert.ok(elapsed >= 12 * 20 - 5, `elapsed ${elapsed}ms`);
  });

  it('mouseDrag defaults to 12 steps and 20ms', async () => {
    const p = new RecordingProvider();
    await p.mouseDrag(0, 0, 10, 10);
    assert.equal(p.calls.filter(c => c[0] === 'move').length, 13);
  });

  it('getCapabilities() default reports native input only', async () => {
    const p = new ComputerUseProvider();
    assert.deepEqual(await p.getCapabilities(), { desktopScreenshot: false, pageScreenshot: false, vnc: false, nativeInput: true });
  });

  it('abstract methods throw not-implemented', async () => {
    const p = new ComputerUseProvider();
    for (const [name, args] of [['start', []], ['stop', []], ['screenshot', [{ space: 'desktop' }]], ['mouseMove', [1, 2]], ['mouseDown', [1, 2]], ['mouseUp', []], ['mouseClick', [1, 2]], ['pressKey', ['a']], ['typeText', ['a']]]) {
      await assert.rejects(() => p[name](...args), new RegExp(`${name}\\(\\) not implemented`));
    }
  });

  it('wait() resolves after the delay', async () => {
    const p = new ComputerUseProvider();
    const t0 = Date.now();
    const r = await p.wait(30);
    assert.equal(r.success, true);
    assert.ok(Date.now() - t0 >= 25);
  });
});
