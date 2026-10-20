# Changelog

## [3.0.0] - 2026-10-20

Hardening release driven by an external audit of 2.2.2 (session isolation,
pool races, process lifecycle, truthful outcomes, redaction, platform
capabilities) and the Lightpanda 1.0 upgrade.

### Breaking Changes
- **`success` means usable content** — `scrape()` now returns `success: true` only when the transport worked *and* `contentStatus === 'usable'`. Empty bodies, SPA shells, block/challenge pages and 4xx/5xx are `success: false` with `contentStatus` set (`empty`, `browser_required_shell`, `blocked`, `navigation_error`). `transportSuccess` tells you whether the request itself completed.
- **Chrome sandbox and web security stay on** by default. Containers must opt in with `noSandbox: true` (or `BNCA_CHROME_NO_SANDBOX=1`); `disableWebSecurity: true` is explicit.
- **Hosted AI endpoint removed** — `askAI()` no longer falls back to `bnca-api.fly.dev`. Pass `{ aiEndpoint, aiApiKey }` for your own service; a bare `apiKey` is ignored with a one-time warning.
- **Pooled sessions are isolated** — `BrowserSession` creates a fresh browser context per session (`isolate: true`). `isolate: false` restores the shared default context.
- **Mutating actions are never replayed** — `click/type/select/pressKey` return `outcome: 'uncertain'` (with `uncertainReason`) when the request left but no usable response came back, instead of retrying on another engine. An LP click that fails to navigate switches to Chrome and reports `uncertain` (previously it re-clicked).
- **`typeText()` needs a focused editable** — returns `outcome: 'uncertain', uncertainReason: 'no_focused_editable'` instead of typing into the body. Native typing is `desktopType()`.
- **`screenshot()` in computer-use mode captures the desktop** by default and returns `{ coordinateSpace, width, height, dpr, offset }`; ask for `{ space: 'page' }` explicitly.
- **`stopLightPandaServer()` and `LightPandaServer.stop()` are async** and await process exit.
- **`BrowserPool.closeAll()` drains; `shutdown()` closes** — `closeAll()` rejects queued callers and closes browsers but the pool stays usable (what `scraper.cleanup()` relies on). `shutdown()` is the permanent close; `reopen()` reverses it.
- **No SIGTERM/SIGINT listeners** are registered by the library any more (they swallowed the host's signals). Call `scraper.cleanup()` / `stopLightPandaServer()` from your own handlers.
- **Puppeteer peer range** is `>=24.38.0 <26`; `ws` is now a declared dependency. Node 20+.

### Lightpanda 1.0.1
- Installer pins release `1.0.1` (tags no longer carry a `v`), verifies SHA-256 for all four assets, downloads to a temp file and renames atomically, bounds redirects, version-checks an existing binary and replaces stale ones, health-checks the binary, and never fails `npm install` (`BNCA_SKIP_LIGHTPANDA_INSTALL=1` to skip, `LIGHTPANDA_PATH` to point at your own).
- `fetch --json` is used for structured `http_status`/`url`/`error`; hyphenated flags (`--with-frames`, `--http-timeout`, `--wait-ms`, `--terminate-ms`, `--cdp-max-connections`); crash detection (`errorType: 'engine_crash'`).
- Server readiness matches the 1.0.x `server running` log line (or `/json/version`), start is idempotent, timers are cleared, a crash respawns on the next start.
- Note: 1.0 enforces CORS by default and removed `setImmediate`; pages relying on either may now need Chrome.
- Note: the 1.0.x Linux binaries link against glibc 2.38. Debian 12 (bookworm, `node:22-slim`) cannot run them; use Debian 13 (`node:22-trixie-slim`) or Ubuntu 24.04+. The installer reports the loader error and this hint instead of silently falling back.

### Added
- Result fields: `transportSuccess`, `httpStatus`, `finalUrl`, `redirectChain`, `engine`, `contentStatus`, `contentReasons`, `textLength`, `trace`; `acceptContent(ctx)` caller hook (`rejected_by_caller`).
- `deadline` (total budget) and `signal` (AbortSignal) for `scrape()` and `BrowserSession`; every stage gets only the remaining budget; stages after expiry are `cancelled`.
- `BrowserSession` mode `'chrome'` (pooled headless Chrome), `checkpoint()/restore()`, `frames()/useFrame()/useMainFrame()`, `pages()/usePage()/waitForNewPage()` + `'newPage'` event, shadow-root `pierce/` refs, `setDialogHandler()/getDialogs()`, `uploadFile()`, `waitForFileChooser()`, `enableDownloads()/downloads()/waitForDownload()`, `getGeometry()/calibrate()/toDesktop()/toPage()`, `{ space }` on every coordinate action, `desktopKey()/desktopType()`, `getProviderInfo()`.
- `getPageState()` v2: stable `[data-bnca-ref]` selectors, role/label/required/disabled/checked/invalid/validationMessage/bounds, forms with validity, configurable limits with truncation reporting, redacted sensitive values, works inside frames and shadow roots.
- Redaction everywhere by default: typed text, password/OTP values, URL secrets never enter history, page state, traces or error messages (`recordTypedText`, `redact` to opt out).
- `checkCapabilities()` / `requireCapability()` / `CapabilityError` with install hints; `modes` says what the machine can run.
- `Trace` telemetry: per-stage engine, duration, queue time, bytes, HTTP status, outcome, token usage; `scraper.on('trace')`.
- `LocalProvider`: transactional start/stop with rollback, unique display lock, temp profile, readiness checks, minimal child environment, loopback-only VNC (password required for other binds) verified before use, `screenshot({ space })` (desktop via ImageMagick), `mouseDown/mouseUp`, interpolated `mouseDrag`, W3C key names.
- `BrowserPool`: reservations (never exceeds the max), cancellable bounded queue, crash recovery, events, `configure()`.
- Exports: `BrowserPool`, `Deadline`, `CONTENT_STATUS`, `classifyContent`, `findChromePath`, `checkCapabilities`, `Trace`, redaction helpers, `normalizeXdoKey`, `LIGHTPANDA_VERSION`, `installLightpanda`, `getBrowserPoolStats`, process helpers.
- Linux Docker test image, packed-tarball smoke test, GitHub Actions matrix (Node 20/22, linux/amd64 + linux/arm64), computer-use Docker example.

### Fixed
- Pool could exceed its maximum under concurrent acquisition; queued callers could hang forever; a crashed browser left a dead slot.
- Sessions sharing a pooled browser could read each other's cookies and storage.
- Paths with spaces broke binary discovery (`new URL().pathname` → `fileURLToPath`).
- Duplicate `cleanup()` definition; bulk stats never counted `direct-fetch`.
- Chrome binary discovery is shared (`findChromePath`, honours `BNCA_CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`).

### Known behaviour
- Chromium's HTTP transport re-sends a navigation POST once when the socket died before any response headers arrived (preconnected sockets count as reused). This happens below the DevTools request layer and outside the library; treat `outcome: 'uncertain'` as "possibly written".

## [2.0.0] - 2026-03-07

### Breaking Changes
- **Node.js 20+ required** — dropped support for Node 18
- **Removed `node-fetch` dependency** — uses built-in `fetch` (Node 20+)
- **`pdf-parse` upgraded to v2** — new class-based API under the hood (public API unchanged)

### Updated
- **LightPanda v0.2.5** — upgraded from nightly to stable release with new CLI flags (`--dump html|markdown`, `--with_frames`, `--http_timeout`)
- **Puppeteer peer dep** — bumped to `^24.38.0`, `headless: true` replaces deprecated `headless: 'new'`
- **Install script** — architecture-aware binary downloads (aarch64/x86_64) for macOS and Linux

### Fixed
- `__NEXT_DATA__` / `__INITIAL_STATE__` extraction regex was broken (produced 4 trailing underscores, never matched)
- LightPanda now uses `--with_frames` for iframe content and `--http_timeout` for proper timeout control

### Added
- Comprehensive test suite (78 tests) covering fallback chain, browser detection, PDF parsing, screenshots, content extraction, and real-site integration
- LightPanda markdown output mode via `lightpandaFormat: 'markdown'` option

## [1.8.1] - 2025-07-02

### Fixed
- Critical fix: Added browser-pool.js to npm package files
- Added BULK_SCRAPING.md to npm package

## [1.8.0] - 2025-07-02

### Added
- **Bulk Scraping**: New `bulkScrape()` and `bulkScrapeStream()` methods for efficient multi-URL processing
- **Request Queueing**: Automatic request queueing when browser pool is full (no more errors!)
- **Progress Tracking**: Real-time progress callbacks for bulk operations
- **Streaming Results**: Process results as they complete for better memory efficiency
- Browser pool management system with configurable max instances and idle timeout
- Automatic browser instance reuse for better performance
- Graceful shutdown handling for browser instances
- `cleanup()` method for manual resource cleanup
- Comprehensive bulk scraping documentation in BULK_SCRAPING.md

### Fixed
- Critical memory leak where Chromium instances were not being properly closed
- Implemented browser instance pooling with automatic cleanup
- Added resource cleanup to prevent "Out of memory" crashes
- Fixed parallel request handling to queue gracefully instead of throwing errors

### Performance
- 2-3x faster subsequent requests due to browser reuse
- Controlled memory usage with automatic idle browser cleanup
- Prevents accumulation of zombie Chromium processes
- Efficient bulk processing with configurable concurrency

## [1.7.0] - 2025-07-02

### Fixed
- Critical bug where platform-specific binaries were being bundled in npm package
- Removed `bin/` directory from package.json files array to ensure fresh binary downloads per platform
- Fixed Linux deployment failures caused by bundled macOS binaries

### Impact
- Resolves "cannot execute binary file: Exec format error" on Linux systems
- Ensures correct platform-specific Lightpanda binary is downloaded during installation
- Prevents cross-platform binary compatibility issues

## [1.6.0] - 2025-07-02

### Added
- Method override parameter to force specific scraping methods (`method: 'direct' | 'lightpanda' | 'puppeteer' | 'auto'`)
- Enhanced error handling with categorized error types (`network`, `timeout`, `parsing`, `service_unavailable`)
- Fallback chain tracking in auto mode to show which methods were attempted
- Detailed error messages for each scraping method failure

### Improved
- No automatic fallback when a specific method is forced - fails gracefully with descriptive errors
- Better error categorization for debugging and monitoring
- TypeScript definitions updated with new method parameter and error fields

### Use Cases
- Test specific scraping methods in isolation
- Optimize performance for known site requirements
- Debug method-specific issues
- Enable Lightpanda team to test each method independently

## [1.5.0] - 2025-06-15

### Added
- AI-powered Q&A functionality with `askAI()` method
- Support for OpenRouter API integration
- Support for OpenAI API and compatible endpoints (Groq, Together AI, etc.)
- Local fallback AI processing when no API key is provided
- Convenience function `askWebsiteAI()` for one-liner Q&A

## [1.3.0] - 2025-06-10

### Added
- PDF parsing support with automatic detection
- Smart PDF detection via URL patterns, content-type headers, and magic bytes
- Text extraction, metadata parsing, and page count from PDFs
- Handles PDFs served with incorrect content-types

## [1.2.0] - 2025-06-05

### Added
- Auto-installation of Lightpanda binary during npm install
- Cross-platform support with automatic OS detection
- Improved binary detection and ES6 module compatibility
- Better error handling with retry logic
- Zero configuration setup

## [1.1.1] - 2025-01-18

### Fixed
- Fixed false positives in browser requirement detection for sites using Cloudflare CDN
- Updated Cloudflare detection to be more specific (only triggers on actual protection/challenge pages, not CDN usage)
- Improved direct fetch success rate for Shopify and other sites using Cloudflare CDN

## [1.1.0] - 2025-05-31

### Added
- New `screenshot()` method for capturing webpage screenshots
- New `quickshot()` method with optimized timeout handling and retry logic
- Convenience functions: `smartScreenshot()` and `quickShot()`
- Chrome/Chromium path detection for multiple platforms
- TypeScript definitions for all new methods

### Improved
- Better timeout handling using SIGTERM before SIGKILL
- Screenshot retry mechanism for reliability
- Support for Fly.io deployment environments

### Performance
- Quickshot method provides 2-3x faster screenshot capture
- Configurable timeouts: 8s initial, 12s on retry
- Smart virtual time budget adjustment

## [1.0.3] - 2025-05-30

### Fixed
- Made puppeteer an optional peer dependency
- Improved error handling when puppeteer is not available

## [1.0.2] - 2025-05-29

### Added
- Initial release with 3-tier fallback system
- Direct fetch, Lightpanda, and Puppeteer methods
- Performance benchmarks showing 11.35x speed improvement
- Full TypeScript support