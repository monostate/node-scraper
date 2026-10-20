import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXdoKey } from '../keymap.js';

describe('normalizeXdoKey', () => {
  const cases = [
    ['Enter', 'Return'], ['Return', 'Return'], ['Backspace', 'BackSpace'], ['Escape', 'Escape'], ['Esc', 'Escape'],
    ['Tab', 'Tab'], ['Delete', 'Delete'], ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
    [' ', 'space'], ['Space', 'space'], ['PageUp', 'Prior'], ['PageDown', 'Next'], ['Home', 'Home'], ['End', 'End'],
    ['ctrl+a', 'ctrl+a'], ['Control+Shift+ArrowLeft', 'ctrl+shift+Left'], ['Meta+c', 'super+c'], ['Cmd+v', 'super+v'], ['Alt+Tab', 'alt+Tab'],
    ['a', 'a'], ['A', 'A'], ['F5', 'F5'], ['+', 'plus'], ['shift++', 'shift+plus'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(normalizeXdoKey(input), expected));
  }
  it('rejects empty input', () => {
    assert.throws(() => normalizeXdoKey(''), /invalid key/);
    assert.throws(() => normalizeXdoKey(null), /invalid key/);
  });
});
