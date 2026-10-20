/**
 * Content status classification — separates "the transport worked" from
 * "we got something a caller can use".
 */

export const CONTENT_STATUS = Object.freeze({
  USABLE: 'usable',
  SHELL: 'browser_required_shell',
  BLOCKED: 'blocked',
  EMPTY: 'empty',
  NAVIGATION_ERROR: 'navigation_error',
  UNSUPPORTED: 'unsupported',
});

export const MIN_USABLE_TEXT_CHARS = 50;
export const SHELL_TEXT_CHARS = 200;

export const BLOCKED_HTTP_STATUSES = new Set([401, 403, 407, 429, 503]);

export const BLOCKED_PATTERNS = [
  /access denied/i,
  /attention required/i,
  /just a moment/i,
  /checking your browser/i,
  /verify (that )?you are (a )?human/i,
  /captcha/i,
  /request blocked/i,
  /pardon our interruption/i,
  /unusual traffic/i,
  /enable cookies to continue/i,
  /you have been blocked/i,
];

const SPA_INDICATORS = [
  /<div[^>]*id=['"]?(root|app|__next|__nuxt)['"]?[^>]*>\s*<\/div>/i,
  /<div[^>]*data-reactroot/i,
  /window\.__NEXT_DATA__/i,
  /window\.__NUXT__/i,
  /_next\/static/i,
  /__webpack_require__/i,
];

export function stripHtmlToText(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html = '') {
  return String(html).match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
}

/**
 * @param {{ httpStatus?: number|null, html?: string, text?: string, title?: string, error?: string|Error|null }} input
 * @returns {{ status: string, reasons: string[] }}
 */
export function classifyContent({ httpStatus = null, html = '', text, title, error } = {}) {
  const errMsg = error ? (typeof error === 'string' ? error : error.message || String(error)) : '';
  if (errMsg && !html && !text) {
    return { status: CONTENT_STATUS.NAVIGATION_ERROR, reasons: [`error:${errMsg.slice(0, 80)}`] };
  }

  const bodyText = typeof text === 'string' ? text.trim() : stripHtmlToText(html);
  const pageTitle = title ?? extractTitle(html);

  if (httpStatus != null && BLOCKED_HTTP_STATUSES.has(Number(httpStatus))) {
    return { status: CONTENT_STATUS.BLOCKED, reasons: [`http_${httpStatus}`] };
  }

  const probe = `${pageTitle}\n${bodyText.slice(0, 2000)}`;
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(probe)) {
      return { status: CONTENT_STATUS.BLOCKED, reasons: [`challenge:${re.source}`] };
    }
  }

  if (httpStatus != null && Number(httpStatus) >= 400) {
    return { status: CONTENT_STATUS.NAVIGATION_ERROR, reasons: [`http_${httpStatus}`] };
  }

  const hasSpa = SPA_INDICATORS.some(re => re.test(html));
  if (bodyText.length < MIN_USABLE_TEXT_CHARS) {
    if (hasSpa) return { status: CONTENT_STATUS.SHELL, reasons: ['spa_root_empty'] };
    return { status: CONTENT_STATUS.EMPTY, reasons: [`text_${bodyText.length}_chars`] };
  }
  if (bodyText.length < SHELL_TEXT_CHARS && hasSpa) {
    return { status: CONTENT_STATUS.SHELL, reasons: ['spa_minimal_text'] };
  }
  return { status: CONTENT_STATUS.USABLE, reasons: [] };
}

export default classifyContent;
