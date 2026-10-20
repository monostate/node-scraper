# @monostate/node-scraper

Intelligent web scraping and browser automation for Node.js: an HTTP fetcher,
[Lightpanda](https://github.com/lightpanda-io/browser) (a fast headless
browser), and Chrome via Puppeteer, with a fallback chain that tells you the
truth about what it got back. Includes a persistent `BrowserSession` for AI
agents (page state, isolated contexts, uploads/downloads, frames, tabs) and a
Linux computer-use provider (Xvfb + Chrome + xdotool, optional VNC).

[![npm](https://img.shields.io/npm/v/@monostate/node-scraper)](https://www.npmjs.com/package/@monostate/node-scraper)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **v3** is a hardening release: isolated sessions, a race-free browser pool,
> transactional process lifecycle, truthful outcomes, redaction by default,
> Lightpanda 1.0.1. See the [migration notes](#migrating-from-2x).

## Install

```bash
npm install @monostate/node-scraper
# Chrome-based modes need Puppeteer (optional peer, >=24.38 <26)
npm install puppeteer
```

`postinstall` downloads the pinned Lightpanda release (1.0.1, SHA-256
verified, atomic). It never fails the install; it prints one status line.
Opt out with `BNCA_SKIP_LIGHTPANDA_INSTALL=1`, or point the package at your
own binary with `LIGHTPANDA_PATH=/path/to/lightpanda`.

Platforms: Lightpanda ships for macOS and Linux (x86_64, aarch64). **The Linux
binaries need glibc ≥ 2.38** — Debian 13 "trixie" (`node:22-trixie-slim`),
Ubuntu 24.04 or newer; Debian 12 "bookworm" (`node:22-slim` today) cannot run
them and the installer says so. Computer-use mode is Linux only
(`apt-get install xvfb xdotool chromium`, optional `x11vnc imagemagick`).
Run `checkCapabilities()` to see what your machine can do.

## Quick start

```js
import { smartScrape } from '@monostate/node-scraper';

const r = await smartScrape('https://example.com');
r.success;        // true only when the content is usable
r.engine;         // 'direct-fetch' | 'lightpanda' | 'puppeteer' | 'pdf'
r.httpStatus;     // 200
r.contentStatus;  // 'usable' | 'browser_required_shell' | 'blocked' | 'empty' | 'navigation_error'
r.finalUrl; r.redirectChain; r.content; r.html; r.trace;
```

## How it decides

```
direct fetch ──usable──▶ done
     │ shell / blocked / empty / error
     ▼
Lightpanda ───usable──▶ done
     │
     ▼
Puppeteer (Chrome) ─▶ done (or success:false with the real reason)
```

`success` is `transportSuccess && contentStatus === 'usable'`. A 200 with an
empty body is `empty`; a React shell is `browser_required_shell`; an "Access
Denied"/challenge page or a 401/403/429/503 is `blocked`; 4xx/5xx and network
failures are `navigation_error`. Nothing is reported as a success because a
socket opened.

```js
import { BNCASmartScraper } from '@monostate/node-scraper';

const scraper = new BNCASmartScraper({ timeout: 10_000 });
scraper.on('trace', t => console.log(t.stages.map(s => `${s.name}:${s.outcome}:${s.durationMs}ms`)));

const r = await scraper.scrape(url, {
  method: 'auto',          // or 'direct' | 'lightpanda' | 'puppeteer'
  deadline: 20_000,        // total budget across all engines
  signal: controller.signal,
  acceptContent: ({ text }) => text.includes('Price') || 'no price on page',
});
if (!r.success) console.log(r.contentStatus, r.contentReasons, r.errorType);
await scraper.cleanup();   // drains the shared Chrome pool; scraper stays usable
```

Other entry points: `scraper.screenshot(url)`, `scraper.quickshot(url)`,
`bulkScrape(urls, { concurrency })`, `bulkScrapeStream(urls, { onResult })`,
PDF URLs are parsed automatically.

### AI questions

```js
const a = await scraper.askAI(url, 'What does this page sell?', {
  openRouterApiKey: process.env.OPENROUTER_API_KEY,   // or openAIApiKey
  // or your own service: aiEndpoint: 'https://ai.example/answer', aiApiKey: '…'
});
a.answer; a.processing; // 'openrouter' | 'openai' | 'endpoint' | 'local'
a.usage;                // { provider, model, inputTokens, outputTokens } — price it yourself
```

There is no implicit hosted endpoint. A bare `apiKey` is ignored.

## Browser sessions (for agents)

```js
import { createSession } from '@monostate/node-scraper';

const s = await createSession({ mode: 'auto', deadline: 120_000 });
// modes: 'headless' (Lightpanda) | 'chrome' (pooled headless Chrome) | 'auto' (LP → Chrome)
//        'visual' (Chrome window) | 'computer-use' (provider: Xvfb + Chrome + xdotool)

await s.goto('https://shop.example/login');
const state = await s.getPageState({ maxElements: 50 });
// state.elements[i] = { ref, selector: '[data-bnca-ref="e12"]', role, label, name,
//   value /* '[redacted]' for password/OTP */, required, disabled, checked, invalid,
//   validationMessage, bounds, inShadow }
// state.truncated = { text, elements, total }; state.forms[i].invalid = ['email']

await s.type(state.elements[0].selector, 'me@example.com');
const r = await s.click('#submit');
// r.outcome: 'ok' | 'uncertain' — a submit whose response was dropped is 'uncertain'
// and is NEVER replayed by the library (see "Mutating actions" below)
```

What a session gives you:

- **Isolation.** Pooled Chrome sessions get their own browser context: no
  shared cookies, storage, IndexedDB or service workers (`isolate: false` to
  share on purpose).
- **Engine fallback with a contract.** When Lightpanda cannot do something
  (screenshots, hover, a navigation it swallowed) the session moves to
  Chrome using `checkpoint()`/`restore()`: URL, cookies (incl. HttpOnly),
  web storage and non-sensitive form values transfer; `notTransferable`
  lists what does not (IndexedDB, service workers, other tabs, in-flight
  requests, history). The `fallback` history entry records `restored` and
  `skipped`.
- **Frames, shadow DOM, tabs.** `frames()`, `useFrame('name'|url|id)`,
  `useMainFrame()`; refs inside open shadow roots are `pierce/` selectors;
  `pages()`, `usePage(i)`, `waitForNewPage()`, `on('newPage')`.
- **Files.** `uploadFile('#cv', ['/abs/file.pdf', { name, data, mimeType }])`
  (verified against `input.files`, `maxUploadBytes`),
  `waitForFileChooser()`, `enableDownloads({ dir })` + `waitForDownload()`.
- **Dialogs.** `setDialogHandler({ action: 'accept', promptText })` or an
  async decision function; everything seen is in `getDialogs()`.
- **Deadlines.** `deadline`/`signal` bound connect and every action; after
  expiry actions reject with `DeadlineError`.
- **Redaction by default.** Typed text, password/OTP values and URL secrets
  never enter `getHistory()`, page state, traces or error messages
  (`recordTypedText: true`, `redact: false` to opt out).

### Mutating actions and uncertainty

Actions are classified (`ACTION_KINDS`): `goto/scroll/hover/extractContent/
evaluate/waitFor/screenshot/getPageState` are safe and may be retried on
another engine; `click/type/select/pressKey/typeText/clickAt/drag/uploadFile`
are mutating and are never replayed once dispatched. If the request left and
no usable response came back you get
`{ success: false, outcome: 'uncertain', uncertainReason }` and decide
yourself.

Chromium itself re-sends a navigation POST once when the socket died before
any response headers arrived (a preconnected socket counts as reused). That
happens below the DevTools request layer and outside this library; treat
`uncertain` as "possibly written".

## Computer-use (Linux)

```js
import { createSession, LocalProvider } from '@monostate/node-scraper';

const provider = new LocalProvider({ enableVnc: true, screenWidth: 1280, screenHeight: 800 });
const s = await createSession({ mode: 'computer-use', provider });
s.getProviderInfo();            // { cdpUrl, display, profileDir, vnc: { host, port, auth, loopbackOnly } }

await s.goto('https://example.com');
await s.calibrate();            // measures the page↔desktop offset from a real mouse event
await s.clickAt(x, y, { space: 'page' });     // page coordinates (from getPageState().bounds)
await s.clickAt(x, y);                        // desktop pixels (default)
const shot = await s.screenshot();            // desktop capture: { coordinateSpace:'desktop', width, height, dpr, offset }
await s.screenshot({ space: 'page' });        // viewport capture

await s.pressKey('Enter');                    // page input (CDP) — every mode
await s.desktopKey('Control+Shift+ArrowLeft'); // native input — reaches native dialogs
await s.desktopType('text');                  // native typing
await s.drag(x1, y1, x2, y2, { space: 'page', steps: 12 }); // interpolated, HTML5 DnD works
```

`LocalProvider` is transactional: display lock, temp profile, Xvfb, Chrome
and x11vnc are acquired in order and rolled back in reverse on any failure;
`stop()` awaits exit (SIGTERM → SIGKILL) and removes the profile. Children get
a minimal environment (never your secrets). VNC binds to loopback with no
password by default; any other bind requires `vnc.password`. Desktop
screenshots need ImageMagick (`import`); without it you get a
`CapabilityError` with the install hint. See `examples/computer-use-linux`.

## Capabilities

```js
import { checkCapabilities } from '@monostate/node-scraper';
const caps = await checkCapabilities();
caps.modes;   // { http, lightpanda, chrome, visual, computerUse, vnc }
caps.missing; // [{ capability: 'xdotool', install: 'apt-get install xdotool' }, …]
```

## Security defaults

- Chrome's sandbox and same-origin policy stay **on**. Containers that run as
  root must opt in: `noSandbox: true` or `BNCA_CHROME_NO_SANDBOX=1`. A failed
  sandbox start produces an error that says exactly that.
- `BNCA_CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` select the
  Chrome binary; `LIGHTPANDA_PATH` selects Lightpanda.
- Chrome launch options are **process-wide**: there is one shared pool, so
  `noSandbox`/`disableWebSecurity` passed to any scraper or session
  reconfigure it for later launches. Browsers already running keep their
  flags; the pool emits a `warn` event (and one console line) when flags
  change while browsers exist. Decide these once, at startup.
- The library registers no `SIGTERM`/`SIGINT` handlers. Call
  `scraper.cleanup()` / `browserPool.shutdown()` / `stopLightPandaServer()`
  from yours.

## Telemetry

Every `scrape()`/`askAI()` result carries `trace`: per-stage engine,
duration, queue time, bytes, HTTP status, outcome/reason, and token usage
when the package itself called a model. `scraper.on('trace', fn)` streams
them. Traces are redacted.

## Migrating from 2.x

| 2.x | 3.x |
| --- | --- |
| `success: true` for shells/blocked pages | check `contentStatus`; `success` means usable |
| Chrome launched with `--no-sandbox`, `--disable-web-security` | opt in: `noSandbox: true`, `disableWebSecurity: true` |
| `askAI({ apiKey })` → hosted endpoint | `askAI({ aiEndpoint, aiApiKey })` or OpenRouter/OpenAI keys |
| pooled sessions shared cookies | isolated contexts (`isolate: false` to share) |
| failed click retried on Chrome | `outcome: 'uncertain'`, you decide |
| `typeText()` with nothing focused "succeeded" | `outcome: 'uncertain', uncertainReason: 'no_focused_editable'`; native typing is `desktopType()` |
| `screenshot()` in computer-use = page | desktop by default, `{ space: 'page' }` for the viewport |
| `stopLightPandaServer()` sync | `await stopLightPandaServer()` |
| `browserPool.closeAll()` permanent | drain; `shutdown()` is permanent |
| Lightpanda v0.2.5 | 1.0.1 (CORS enforced by default; `setImmediate` removed) |

## Development

```bash
npm test                      # node --test 'test/*.test.mjs' under a 180s per-file budget (Chrome + Lightpanda + fixtures)
bash docker/run-linux-tests.sh  # full suite incl. Linux computer-use tests in Docker
bash scripts/smoke-packed.sh    # pack, install into an empty project, scrape through the tarball
```

Tests run against a local fixture server (`test/fixtures/server.mjs`); no
public website is required.

## License

MIT
