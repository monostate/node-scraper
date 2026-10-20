/**
 * In-page state collector for AI agents.
 *
 * `collectPageState` is serialized and executed INSIDE the page via
 * `page.evaluate(collectPageState, opts)`, so it must be self-contained: no
 * imports, no closures over module scope. Everything it needs arrives in
 * `opts`.
 *
 * It stamps a stable `data-bnca-ref` attribute on every collected element so
 * callers get selectors that survive repeated labels, odd ids and shadow
 * roots: `[data-bnca-ref="e12"]`.
 */

export const DEFAULT_REF_ATTR = 'data-bnca-ref';

/**
 * @param {{ maxText?: number, maxElements?: number, offset?: number, includeValues?: boolean, sensitiveRe?: string, refAttr?: string }} opts
 */
export function collectPageState(opts) {
  const {
    maxText = 3000,
    maxElements = 50,
    offset = 0,
    includeValues = true,
    sensitiveRe = null,
    refAttr = 'data-bnca-ref',
  } = opts || {};

  const sensitive = sensitiveRe ? new RegExp(sensitiveRe, 'i') : null;
  const SENSITIVE_AUTOCOMPLETE = new Set(['one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'new-password', 'current-password']);
  const SELECTOR = [
    'button', '[role="button"]', 'input', 'select', 'textarea', 'a[href]', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]', '[role="menuitem"]', '[role="combobox"]', '[role="textbox"]', '[role="switch"]',
  ].join(', ');

  function* walk(root, inShadow) {
    for (const el of root.querySelectorAll(SELECTOR)) yield [el, inShadow];
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) yield* walk(host.shadowRoot, true);
    }
  }

  // Engines without a layout tree (LightPanda) report no client rects for
  // anything; fall back to attribute/style-based visibility there.
  const layoutAvailable = Boolean(document.body && typeof document.body.getClientRects === 'function' && document.body.getClientRects().length > 0);
  function visible(el) {
    if (el.type === 'hidden' || el.hidden) return false;
    if (layoutAvailable) {
      if (!el.getClientRects().length) return false;
    }
    let cs = null;
    try { cs = getComputedStyle(el); } catch { /* unsupported */ }
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return false;
    return true;
  }

  function textOf(el) {
    const t = (el.innerText || el.textContent || '').trim();
    if (t) return t.slice(0, 100);
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return String(el.value || '').slice(0, 100);
    return '';
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 100);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map(id => (el.getRootNode().getElementById?.(id) || document.getElementById(id))?.textContent?.trim() || '').join(' ').trim();
      if (t) return t.slice(0, 100);
    }
    const labels = el.labels;
    if (labels && labels.length) {
      const t = Array.from(labels).map(l => l.textContent.trim()).join(' ').trim();
      if (t) return t.slice(0, 100);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = wrapping.textContent.trim();
      if (t) return t.slice(0, 100);
    }
    return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 100);
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }

  function isSensitive(el, label) {
    const type = (el.type || '').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (ac && SENSITIVE_AUTOCOMPLETE.has(ac)) return true;
    if (!sensitive) return false;
    return [el.name, el.id, label, el.getAttribute('placeholder')].some(v => v && sensitive.test(String(v)));
  }

  if (typeof window.__bncaRefCounter !== 'number') {
    // Resume numbering after any refs that already exist on the page.
    let max = 0;
    for (const [el] of walk(document, false)) {
      const m = /^e(\d+)$/.exec(el.getAttribute(refAttr) || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    window.__bncaRefCounter = max;
  }
  function refFor(el) {
    let ref = el.getAttribute(refAttr);
    if (!ref) {
      ref = `e${++window.__bncaRefCounter}`;
      el.setAttribute(refAttr, ref);
    }
    return ref;
  }

  const collected = [];
  for (const [el, inShadow] of walk(document, false)) {
    if (!visible(el)) continue;
    const label = labelOf(el);
    const role = roleOf(el);
    const ref = refFor(el);
    const rect = el.getBoundingClientRect();
    const isCheck = role === 'checkbox' || role === 'radio' || role === 'switch';
    const hasValue = 'value' in el && !['button', 'link', 'generic'].includes(role);
    const willValidate = typeof el.willValidate === 'boolean' && el.willValidate;
    const record = {
      ref,
      selector: `[${refAttr}="${ref}"]`,
      id: el.id || null,
      role,
      tag: el.tagName.toLowerCase(),
      type: el.type ? String(el.type).toLowerCase() : null,
      text: textOf(el),
      label,
      name: el.name || null,
      placeholder: el.getAttribute('placeholder') || null,
      href: el.href || null,
      required: Boolean(el.required),
      disabled: Boolean(el.disabled),
      invalid: willValidate ? !el.checkValidity() : false,
      validationMessage: willValidate ? (el.validationMessage || '') : '',
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      inShadow,
    };
    if (isCheck) record.checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
    if (includeValues && hasValue) {
      record.value = isSensitive(el, label) ? '[redacted]' : String(el.value ?? '').slice(0, 200);
    }
    collected.push(record);
  }

  const elements = collected.slice(offset, offset + maxElements);
  const fullText = document.body?.innerText || '';

  const forms = Array.from(document.querySelectorAll('form')).map((form) => ({
    ref: refFor(form),
    selector: `[${refAttr}="${refFor(form)}"]`,
    id: form.id || null,
    action: form.action || null,
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    invalid: Array.from(form.elements)
      .filter(e => e.willValidate && !e.checkValidity())
      .map(e => e.name || e.id || e.tagName.toLowerCase()),
  }));

  return {
    url: location.href,
    title: document.title,
    text: fullText.slice(0, maxText),
    textTruncated: fullText.length > maxText,
    elements,
    elementsTotal: collected.length,
    elementsTruncated: offset + elements.length < collected.length,
    forms,
  };
}

export default collectPageState;
