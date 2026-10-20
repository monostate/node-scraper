/**
 * Redaction helpers.
 *
 * Used by BrowserSession (history, page state), telemetry traces and error
 * messages so that typed secrets, password/OTP values and URL credentials
 * never leak into logs or structured output by default.
 */

export const SENSITIVE_FIELD_RE = /pass(word|wd|code|phrase)?|pwd|secret|token|otp|one[-_ ]?time|cvv|cvc|ssn|card[-_ ]?number|api[-_]?key|auth/i;

export const SENSITIVE_QUERY_KEYS = [
  'token', 'access_token', 'refresh_token', 'id_token',
  'key', 'api_key', 'apikey', 'secret', 'password', 'pwd',
  'auth', 'code', 'session', 'sid', 'sig', 'signature',
];

const SENSITIVE_AUTOCOMPLETE = new Set([
  'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  'new-password', 'current-password',
]);

const SENSITIVE_INPUT_TYPES = new Set(['password']);

/**
 * @param {{ type?: string, name?: string, id?: string, autocomplete?: string, label?: string, placeholder?: string }} field
 */
export function isSensitiveField(field = {}) {
  if (!field) return false;
  if (field.type && SENSITIVE_INPUT_TYPES.has(String(field.type).toLowerCase())) return true;
  if (field.autocomplete && SENSITIVE_AUTOCOMPLETE.has(String(field.autocomplete).toLowerCase().trim())) return true;
  for (const key of ['name', 'id', 'label', 'placeholder']) {
    const v = field[key];
    if (v && SENSITIVE_FIELD_RE.test(String(v))) return true;
  }
  return false;
}

export function redactText(text) {
  const len = text == null ? 0 : String(text).length;
  return `[redacted ${len} chars]`;
}

export function redactValue(value, field) {
  return isSensitiveField(field) ? redactText(value) : value;
}

const QUERY_KEY_SET = new Set(SENSITIVE_QUERY_KEYS.map(k => k.toLowerCase()));

/**
 * Remove userinfo and mask sensitive query parameter values.
 * Non-URL input is returned unchanged.
 */
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (QUERY_KEY_SET.has(key.toLowerCase())) {
      parsed.searchParams.set(key, '[redacted]');
      changed = true;
    }
  }
  // OAuth implicit / id_token callbacks carry secrets in the fragment.
  if (parsed.hash && parsed.hash.includes('=')) {
    const params = new URLSearchParams(parsed.hash.slice(1));
    let hashChanged = false;
    for (const key of [...params.keys()]) {
      if (QUERY_KEY_SET.has(key.toLowerCase())) {
        params.set(key, '[redacted]');
        hashChanged = true;
      }
    }
    if (hashChanged) {
      parsed.hash = `#${params.toString()}`;
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>]+/g;
// value part refuses a bare "Bearer" so `Authorization: Bearer <token>` is handled by BEARER_RE
const KV_SECRET_RE = /\b(password|passwd|pwd|token|secret|api[_-]?key|key|authorization)\s*[=:]\s*(["']?)(?!bearer\b)[^\s"'&,;]+\2/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Mask secrets that commonly appear in error messages: URLs with credentials
 * or sensitive query params, and `password=...` style pairs.
 */
export function redactErrorMessage(message) {
  if (message == null) return '';
  const text = typeof message === 'string' ? message : (message.message ?? String(message));
  return text
    .replace(URL_IN_TEXT_RE, (m) => redactUrl(m))
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(KV_SECRET_RE, (m, k) => `${k}=[redacted]`);
}

export default {
  SENSITIVE_FIELD_RE, SENSITIVE_QUERY_KEYS,
  isSensitiveField, redactUrl, redactText, redactValue, redactErrorMessage,
};
