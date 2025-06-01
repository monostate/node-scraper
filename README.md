# @monostate/node-scraper

> **Lightning-fast web scraping with intelligent fallback system - 11.35x faster than Firecrawl**

[![npm version](https://badge.fury.io/js/%40monostate%2Fnode-scraper.svg)](https://badge.fury.io/js/%40monostate%2Fnode-scraper)
[![Performance](https://img.shields.io/badge/Performance-11.35x_faster_than_Firecrawl-brightgreen)](../../test-results/) 
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Node](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)

## 🚀 Quick Start

### Installation

```bash
npm install @monostate/node-scraper
# or
yarn add @monostate/node-scraper
# or  
pnpm add @monostate/node-scraper
```

**🎉 New in v1.2.0**: Lightpanda binary is now automatically downloaded and configured during installation! No manual setup required.

### Zero-Configuration Setup

The package now automatically:
- 📦 Downloads the correct Lightpanda binary for your platform (macOS, Linux, Windows/WSL)
- 🔧 Configures binary paths and permissions
- ✅ Validates installation health on first use

### Basic Usage

```javascript
import { smartScrape, smartScreenshot, quickShot } from '@monostate/node-scraper';

// Simple one-line scraping
const result = await smartScrape('https://example.com');
console.log(result.content); // Extracted content
console.log(result.method);  // Method used: direct-fetch, lightpanda, or puppeteer

// Take a screenshot
const screenshot = await smartScreenshot('https://example.com');
console.log(screenshot.screenshot); // Base64 encoded image

// Quick screenshot (optimized for speed)
const quick = await quickShot('https://example.com');
console.log(quick.screenshot); // Fast screenshot capture
```

### Advanced Usage

```javascript
import { BNCASmartScraper } from '@monostate/node-scraper';

const scraper = new BNCASmartScraper({
  timeout: 10000,
  verbose: true,
  lightpandaPath: './lightpanda' // optional
});

const result = await scraper.scrape('https://complex-spa.com');
console.log(result.stats); // Performance statistics

await scraper.cleanup(); // Clean up resources
```

## 🔧 How It Works

BNCA uses a sophisticated 3-tier fallback system:

### 1. 🔄 Direct Fetch (Fastest)
- Pure HTTP requests with intelligent HTML parsing
- **Performance**: Sub-second responses
- **Success rate**: 75% of websites

### 2. 🐼 Lightpanda Browser (Fast)
- Lightweight browser engine (2-3x faster than Chromium)
- **Performance**: Fast JavaScript execution
- **Fallback triggers**: SPA detection

### 3. 🔵 Puppeteer (Complete)
- Full Chromium browser for maximum compatibility
- **Performance**: Complete JavaScript execution
- **Fallback triggers**: Complex interactions needed

### 📸 Screenshot Methods
- **Chrome CLI**: Direct Chrome screenshot capture
- **Quickshot**: Optimized with retry logic and smart timeouts

## 📊 Performance Benchmark

| Site Type | BNCA | Firecrawl | Speed Advantage |
|-----------|------|-----------|----------------|
| **Wikipedia** | 154ms | 4,662ms | **30.3x faster** |
| **Hacker News** | 1,715ms | 4,644ms | **2.7x faster** |
| **GitHub** | 9,167ms | 9,790ms | **1.1x faster** |

**Average**: 11.35x faster than Firecrawl with 100% reliability

## 🎛️ API Reference

### Convenience Functions

#### `smartScrape(url, options?)`
Quick scraping with intelligent fallback.

#### `smartScreenshot(url, options?)`
Take a screenshot of any webpage.

#### `quickShot(url, options?)`
Optimized screenshot capture for maximum speed.

**Parameters:**
- `url` (string): URL to scrape/capture
- `options` (object, optional): Configuration options

**Returns:** Promise<ScrapingResult>

### `BNCASmartScraper`

Main scraper class with advanced features.

#### Constructor Options

```javascript
const scraper = new BNCASmartScraper({
  timeout: 10000,           // Request timeout in ms
  retries: 2,               // Number of retries per method
  verbose: false,           // Enable detailed logging
  lightpandaPath: './lightpanda', // Path to Lightpanda binary
  userAgent: 'Mozilla/5.0 ...',   // Custom user agent
});
```

#### Methods

##### `scraper.scrape(url, options?)`

Scrape a URL with intelligent fallback.

```javascript
const result = await scraper.scrape('https://example.com');
```

##### `scraper.screenshot(url, options?)`

Take a screenshot of a webpage.

```javascript
const result = await scraper.screenshot('https://example.com');
const img = result.screenshot; // data:image/png;base64,...
```

##### `scraper.quickshot(url, options?)`

Quick screenshot capture - optimized for speed with retry logic.

```javascript
const result = await scraper.quickshot('https://example.com');
// 2-3x faster than regular screenshot
```

##### `scraper.getStats()`

Get performance statistics.

```javascript
const stats = scraper.getStats();
console.log(stats.successRates); // Success rates by method
```

##### `scraper.healthCheck()`

Check availability of all scraping methods.

```javascript
const health = await scraper.healthCheck();
console.log(health.status); // 'healthy' or 'unhealthy'
```

##### `scraper.cleanup()`

Clean up resources (close browser instances).

```javascript
await scraper.cleanup();
```

## 📱 Next.js Integration

### API Route Example

```javascript
// pages/api/scrape.js or app/api/scrape/route.js
import { smartScrape } from '@monostate/node-scraper';

export async function POST(request) {
  try {
    const { url } = await request.json();
    const result = await smartScrape(url);
    
    return Response.json({
      success: true,
      data: result.content,
      method: result.method,
      time: result.performance.totalTime
    });
  } catch (error) {
    return Response.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
```

### React Hook Example

```javascript
// hooks/useScraper.js
import { useState } from 'react';

export function useScraper() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const scrape = async (url) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setData(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return { scrape, loading, data, error };
}
```

### Component Example

```javascript
// components/ScraperDemo.jsx
import { useScraper } from '../hooks/useScraper';

export default function ScraperDemo() {
  const { scrape, loading, data, error } = useScraper();
  const [url, setUrl] = useState('');

  const handleScrape = () => {
    if (url) scrape(url);
  };

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-4">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Enter URL to scrape..."
          className="flex-1 px-3 py-2 border rounded"
        />
        <button
          onClick={handleScrape}
          disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {loading ? 'Scraping...' : 'Scrape'}
        </button>
      </div>
      
      {error && (
        <div className="p-3 bg-red-100 text-red-700 rounded mb-4">
          Error: {error}
        </div>
      )}
      
      {data && (
        <div className="p-3 bg-green-100 rounded">
          <h3 className="font-bold mb-2">Scraped Content:</h3>
          <pre className="text-sm overflow-auto">{data}</pre>
        </div>
      )}
    </div>
  );
}
```

## ⚠️ Important Notes

### Server-Side Only
BNCA is designed for **server-side use only** due to:
- Browser automation requirements (Puppeteer)
- File system access for Lightpanda binary
- CORS restrictions in browsers

### Next.js Deployment
- Use in API routes, not client components
- Ensure Node.js 18+ in production environment
- Consider adding Lightpanda binary to deployment

### Lightpanda Setup (Optional)
For maximum performance, install Lightpanda:

```bash
# macOS ARM64
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-macos
chmod +x lightpanda

# Linux x64
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux
chmod +x lightpanda
```

## 🔒 Privacy & Security

- **No external API calls** - all processing is local
- **No data collection** - your data stays private
- **Respects robots.txt** (optional enforcement)
- **Configurable rate limiting**

## 📝 TypeScript Support

Full TypeScript definitions included:

```typescript
import { BNCASmartScraper, ScrapingResult, ScrapingOptions } from '@monostate/node-scraper';

const scraper: BNCASmartScraper = new BNCASmartScraper({
  timeout: 5000,
  verbose: true
});

const result: ScrapingResult = await scraper.scrape('https://example.com');
```

## 📋 Changelog

### v1.2.0 (Latest)
- 🎉 **Auto-Installation**: Lightpanda binary is now automatically downloaded during `npm install`
- 🔧 **Cross-Platform Support**: Automatic detection and installation for macOS, Linux, and Windows/WSL
- ⚡ **Improved Performance**: Enhanced binary detection and ES6 module compatibility
- 🛠️ **Better Error Handling**: More robust installation scripts with retry logic
- 📦 **Zero Configuration**: No manual setup required - works out of the box

### v1.1.1
- Bug fixes and stability improvements
- Enhanced Puppeteer integration

### v1.1.0
- Added screenshot capabilities
- Improved fallback system
- Performance optimizations

## 🤝 Contributing

See the [main repository](https://github.com/your-org/bnca-prototype) for contribution guidelines.

## 📄 License

MIT License - see [LICENSE](../../LICENSE) file for details.

---

<div align="center">

**Built with ❤️ for fast, reliable web scraping**

[⭐ Star on GitHub](https://github.com/your-org/bnca-prototype) | [📖 Full Documentation](https://github.com/your-org/bnca-prototype#readme)

</div>