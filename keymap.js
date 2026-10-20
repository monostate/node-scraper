/**
 * Key-name normalization for native (xdotool) input.
 *
 * Accepts Puppeteer / W3C key names ("Enter", "ArrowLeft", "Control+Shift+A")
 * and returns an xdotool keysym expression ("Return", "Left", "ctrl+shift+A").
 */

const NAMED = Object.freeze({
  enter: 'Return', return: 'Return',
  backspace: 'BackSpace',
  escape: 'Escape', esc: 'Escape',
  tab: 'Tab',
  delete: 'Delete', del: 'Delete',
  insert: 'Insert',
  arrowup: 'Up', up: 'Up',
  arrowdown: 'Down', down: 'Down',
  arrowleft: 'Left', left: 'Left',
  arrowright: 'Right', right: 'Right',
  ' ': 'space', space: 'space', spacebar: 'space',
  pageup: 'Prior', pagedown: 'Next',
  home: 'Home', end: 'End',
  capslock: 'Caps_Lock', numlock: 'Num_Lock', scrolllock: 'Scroll_Lock',
  printscreen: 'Print', contextmenu: 'Menu', pause: 'Pause',
  '+': 'plus', plus: 'plus',
  '-': 'minus', minus: 'minus',
});

const MODIFIERS = Object.freeze({
  control: 'ctrl', ctrl: 'ctrl',
  shift: 'shift',
  alt: 'alt', option: 'alt',
  meta: 'super', cmd: 'super', command: 'super', super: 'super', win: 'super', windows: 'super',
});

function splitCombo(key) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (ch === '+' && buf.length > 0 && i < key.length - 1) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

function normalizeToken(token) {
  const lower = token.toLowerCase();
  if (MODIFIERS[lower]) return { modifier: MODIFIERS[lower] };
  if (NAMED[lower] !== undefined) return { key: NAMED[lower] };
  if (/^f\d{1,2}$/i.test(token)) return { key: token.toUpperCase() };
  return { key: token }; // single printable chars and raw keysyms pass through
}

/**
 * @param {string} key
 * @returns {string} xdotool key expression
 */
export function normalizeXdoKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`invalid key: ${JSON.stringify(key)}`);
  }
  if (key === ' ' || key === '+') return NAMED[key];
  const modifiers = [];
  const keys = [];
  for (const token of splitCombo(key)) {
    const norm = normalizeToken(token);
    if (norm.modifier) modifiers.push(norm.modifier);
    else keys.push(norm.key);
  }
  if (keys.length === 0 && modifiers.length > 0) return modifiers.join('+');
  return [...modifiers, ...keys].join('+');
}

export default normalizeXdoKey;
