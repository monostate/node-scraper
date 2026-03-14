# @monostate/node-scraper

> Intelligent web scraping with multi-tier fallback — 11x faster than traditional scrapers

[![npm](https://img.shields.io/npm/v/@monostate/node-scraper.svg)](https://www.npmjs.com/package/@monostate/node-scraper)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/monostate/node-scraper/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org/)

## Install

```bash
npm install @monostate/node-scraper
```

LightPanda is downloaded automatically on install. Puppeteer is an optional peer dependency for full browser fallback.

## Usage

```javascript
import { smartScrape, smartScreenshot, quickShot } from '@monostate/node-scraper';

// Scrape with automatic method selection
const result = await smartScrape('https://example.com');
console.log(result.content);
console.log(result.method); // 'direct-fetch' | 'lightpanda' | 'puppeteer'

// Screenshots
const screenshot = await smartScreenshot('https://example.com');
const quick = await quickShot('https://example.com'); // optimized for speed

// PDFs are detected and parsed automatically
const pdf = await smartScrape('https://example.com/doc.pdf');
```

### Force a specific method

```javascript
const result = await smartScrape('https://example.com', { method: 'direct' });
// Also: 'lightpanda', 'puppeteer', 'auto' (default)
```

No fallback occurs when a method is forced — useful for testing and debugging.

### Advanced usage

```javascript
import { BNCASmartScraper } from '@monostate/node-scraper';

const scraper = new BNCASmartScraper({
  timeout: 10000,
  verbose: true,
});

const result = await scraper.scrape('https://complex-spa.com');
const stats = scraper.getStats();
const health = await scraper.healthCheck();

await scraper.cleanup();
```

### Bulk scraping

```javascript
import { bulkScrape, bulkScrapeStream } from '@monostate/node-scraper';

const results = await bulkScrape(urls, {
  concurrency: 5,
  continueOnError: true,
  progressCallback: (p) => console.log(`${p.percentage.toFixed(1)}%`),
});

// Or stream results as they complete
await bulkScrapeStream(urls, {
  concurrency: 10,
  onResult: async (result) => await saveToDatabase(result),
  onError: async (error) => console.error(error.url, error.error),
});
```

See [BULK_SCRAPING.md](./BULK_SCRAPING.md) for full documentation.

### Browser sessions

Persistent browser sessions with real-time control. Three modes:

```javascript
import { createSession } from '@monostate/node-scraper';

// Headless (default) — LightPanda with Chrome fallback
const session = await createSession({ mode: 'auto' });
await session.goto('https://example.com');
const content = await session.extractContent();
const state = await session.getPageState({ includeScreenshot: true });
await session.close();

// Visual — Chrome with headless:false for dev/debug
const visual = await createSession({ mode: 'visual' });
await visual.goto('https://example.com');
await visual.screenshot(); // real Chrome rendering
await visual.close();
```

Session methods: `goto`, `click`, `type`, `scroll`, `hover`, `select`, `pressKey`, `goBack`, `goForward`, `screenshot`, `extractContent`, `getPageState`, `waitFor`, `evaluate`, `getCookies`, `setCookies`.

### Computer use (coordinate-based browser control)

For AI agents that navigate by pixel coordinates -- useful for anti-bot sites, dynamic UIs, or anything that can't be scraped with selectors.

```javascript
import { createSession, LocalProvider } from '@monostate/node-scraper';

// LocalProvider runs Xvfb + Chrome + xdotool (Linux only)
const session = await createSession({
  mode: 'computer-use',
  provider: new LocalProvider({ screenWidth: 1280, screenHeight: 800, enableVnc: true }),
});

await session.goto('https://example.com');

// Coordinate-based actions (delegated to provider)
await session.clickAt(640, 400);
await session.typeText('hello world');
await session.mouseMove(100, 200);
await session.drag(10, 20, 300, 400);
await session.scrollAt(640, 400, 'down', 5);
const pos = await session.getCursorPosition();
const size = await session.getScreenSize();

// Selector-based actions still work (via Puppeteer CDP)
await session.click('#submit');
await session.type('#search', 'query');

// VNC streaming URL (if provider supports it)
console.log(session.getVncUrl());

await session.close();
```

#### Custom providers

Implement `ComputerUseProvider` to connect any VM/container backend:

```javascript
import { ComputerUseProvider } from '@monostate/node-scraper';

class MyProvider extends ComputerUseProvider {
  async start() {
    // Provision VM, return { cdpUrl, vncUrl, screenSize }
  }
  async mouseClick(x, y, button) { /* ... */ }
  async screenshot() { /* ... */ }
  async stop() { /* cleanup */ }
}
```

### AI-powered Q&A

Ask questions about any website using OpenRouter, OpenAI, or local fallback:

```javascript
import { askWebsiteAI } from '@monostate/node-scraper';

const answer = await askWebsiteAI('https://example.com', 'What is this site about?', {
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
});
```

API key priority: OpenRouter > OpenAI > BNCA backend > local pattern matching (no key needed).

## How it works

The scraper uses a three-tier fallback system:

1. **Direct fetch** — Pure HTTP with HTML parsing. Sub-second, handles ~75% of sites.
2. **LightPanda** — Lightweight browser engine, 2-3x faster than Chromium. Handles SPAs.
3. **Puppeteer** — Full Chromium for maximum compatibility.

Additional specialized handlers:
- **PDF parser** — Automatic detection by URL, content-type, or magic bytes. Extracts text, metadata, and page count.
- **Screenshots** — Chrome CLI capture with retry logic and smart timeouts.

Browser instances are pooled (max 3, 5s idle timeout) to prevent memory leaks.

## Performance

| Site Type | node-scraper | Firecrawl | Speedup |
|-----------|-------------|-----------|---------|
| Wikipedia | 154ms | 4,662ms | 30.3x |
| Hacker News | 1,715ms | 4,644ms | 2.7x |
| GitHub | 9,167ms | 9,790ms | 1.1x |

Average: **11.35x faster** with 100% reliability.

## API Reference

### Convenience functions

| Function | Description |
|----------|-------------|
| `smartScrape(url, opts?)` | Scrape with intelligent fallback |
| `smartScreenshot(url, opts?)` | Full page screenshot |
| `quickShot(url, opts?)` | Fast screenshot capture |
| `bulkScrape(urls, opts?)` | Batch scrape multiple URLs |
| `bulkScrapeStream(urls, opts?)` | Stream results as they complete |
| `askWebsiteAI(url, question, opts?)` | AI Q&A about a webpage |

### BNCASmartScraper options

```javascript
{
  timeout: 10000,            // Request timeout (ms)
  retries: 2,                // Retries per method
  verbose: false,            // Detailed logging
  lightpandaPath: './bin/lightpanda',
  lightpandaFormat: 'html',  // 'html' or 'markdown'
  userAgent: 'Mozilla/5.0 ...',
  openRouterApiKey: '...',
  openAIApiKey: '...',
  openAIBaseUrl: 'https://api.openai.com',
}
```

### Methods

- `scraper.scrape(url, opts?)` — Scrape with fallback
- `scraper.screenshot(url, opts?)` — Take screenshot
- `scraper.quickshot(url, opts?)` — Fast screenshot
- `scraper.askAI(url, question, opts?)` — AI Q&A
- `scraper.getStats()` — Performance statistics
- `scraper.healthCheck()` — Check method availability
- `scraper.cleanup()` — Close browser instances

### Response shape

```javascript
{
  success: true,
  content: '...',          // Extracted content (JSON string)
  method: 'direct-fetch',  // Method used
  url: 'https://...',
  performance: { totalTime: 154 },
  stats: { ... }
}
```

## TypeScript

Full type definitions are included (`index.d.ts`).

```typescript
import { BNCASmartScraper, ScrapingResult } from '@monostate/node-scraper';
```

## Notes

- **Server-side only** — requires filesystem access and browser automation.
- **Node.js 20+** required.
- LightPanda binary is auto-installed. Puppeteer is optional.
- No external API calls for scraping — all processing is local.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

## License

MIT
