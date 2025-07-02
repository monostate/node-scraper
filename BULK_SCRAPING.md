# Bulk Scraping Guide

The `@monostate/node-scraper` package provides powerful bulk scraping capabilities with automatic request queueing, progress tracking, and efficient resource management.

## Key Features

- **Automatic Request Queueing**: Never worry about "too many browser instances" errors. Requests are automatically queued when the browser pool is full.
- **Smart Browser Pooling**: Reuses browser instances for better performance while preventing memory leaks.
- **Real-time Progress Tracking**: Monitor scraping progress with customizable callbacks.
- **Streaming Support**: Process results as they complete for memory-efficient handling of large datasets.
- **Graceful Error Handling**: Continue processing even when some URLs fail, with detailed error reporting.

## Table of Contents

- [Automatic Request Queueing](#automatic-request-queueing)
- [Basic Usage](#basic-usage)
- [Streaming Results](#streaming-results)
- [Configuration Options](#configuration-options)
- [Error Handling](#error-handling)
- [Performance Optimization](#performance-optimization)
- [Real-World Examples](#real-world-examples)
- [Best Practices](#best-practices)

## Automatic Request Queueing

One of the most powerful features of v1.8.0 is automatic request queueing. When you make multiple concurrent requests:

```javascript
// Before v1.8.0: This would throw errors when browser pool is full
// After v1.8.0: Requests are automatically queued!

const urls = Array.from({ length: 100 }, (_, i) => `https://example.com/page${i}`);

// Even with 100 URLs and only 3 browser instances, no errors!
const results = await bulkScrape(urls, {
  concurrency: 20,  // Request 20 at a time
  method: 'puppeteer'  // Force browser usage
});

// The browser pool (max 3 instances) automatically queues requests
// No "too many browser instances" errors!
```

### How It Works

1. **Browser Pool**: Maximum of 3 browser instances by default
2. **Request Queue**: When all browsers are busy, new requests wait in a queue
3. **Automatic Processing**: As browsers become available, queued requests are processed
4. **No Errors**: Instead of throwing errors, requests wait their turn

### Benefits

- **No Manual Retry Logic**: The SDK handles queueing automatically
- **Memory Efficient**: Only 3 browsers maximum, preventing OOM errors
- **Optimal Performance**: Browsers are reused for faster processing
- **Graceful Degradation**: System remains stable under high load

### Works Everywhere

The automatic queueing works with all scraping methods, not just bulk operations:

```javascript
import { smartScrape } from '@monostate/node-scraper';

// Make 50 parallel requests with Puppeteer
// Only 3 browsers will be created, rest will queue automatically
const promises = [];
for (let i = 0; i < 50; i++) {
  promises.push(
    smartScrape(`https://example.com/page${i}`, { method: 'puppeteer' })
  );
}

// All 50 requests complete successfully!
// No "too many browser instances" errors
const results = await Promise.all(promises);
console.log(`Completed ${results.length} requests with only 3 browsers!`);
```

## Basic Usage

### Simple Bulk Scraping

```javascript
import { bulkScrape } from '@monostate/node-scraper';

const urls = [
  'https://example1.com',
  'https://example2.com',
  'https://example3.com'
];

const results = await bulkScrape(urls);

// Access results
results.success.forEach(result => {
  console.log(`URL: ${result.url}`);
  console.log(`Method: ${result.method}`);
  console.log(`Duration: ${result.duration}ms`);
  console.log(`Content: ${result.content.substring(0, 100)}...`);
});

// Check failures
results.failed.forEach(failure => {
  console.log(`Failed URL: ${failure.url}`);
  console.log(`Error: ${failure.error}`);
});
```

### With Progress Tracking

```javascript
const results = await bulkScrape(urls, {
  progressCallback: (progress) => {
    console.log(`Progress: ${progress.percentage.toFixed(1)}%`);
    console.log(`Current: ${progress.current}`);
    console.log(`Processed: ${progress.processed}/${progress.total}`);
  }
});
```

## Streaming Results

For large datasets, streaming allows you to process results as they complete:

### Basic Streaming

```javascript
import { bulkScrapeStream } from '@monostate/node-scraper';

const stats = await bulkScrapeStream(urls, {
  onResult: (result) => {
    console.log(`Success: ${result.url}`);
    // Process immediately - save to database, write to file, etc.
  },
  onError: (error) => {
    console.log(`Failed: ${error.url} - ${error.error}`);
  }
});

console.log(`Total processed: ${stats.processed}`);
console.log(`Success rate: ${(stats.successful / stats.total * 100).toFixed(1)}%`);
```

### Stream to File

```javascript
import { createWriteStream } from 'fs';
import { bulkScrapeStream } from '@monostate/node-scraper';

const outputStream = createWriteStream('results.jsonl');

await bulkScrapeStream(urls, {
  onResult: async (result) => {
    // Write each result as a JSON line
    outputStream.write(JSON.stringify(result) + '\n');
  },
  onError: async (error) => {
    // Log errors to a separate file
    outputStream.write(JSON.stringify({ ...error, isError: true }) + '\n');
  }
});

outputStream.end();
```

### Stream to Database

```javascript
import { bulkScrapeStream } from '@monostate/node-scraper';
import { db } from './database.js';

await bulkScrapeStream(urls, {
  concurrency: 10,
  onResult: async (result) => {
    await db.scraped_pages.insert({
      url: result.url,
      content: result.content,
      method: result.method,
      duration_ms: result.duration,
      scraped_at: new Date(result.timestamp)
    });
  },
  onError: async (error) => {
    await db.scrape_errors.insert({
      url: error.url,
      error_message: error.error,
      failed_at: new Date(error.timestamp)
    });
  }
});
```

## Configuration Options

### Concurrency Control

```javascript
// Low concurrency for rate-limited sites
const results = await bulkScrape(urls, {
  concurrency: 2,  // Only 2 parallel requests
  timeout: 30000   // 30 second timeout per request
});

// High concurrency for your own servers
const results = await bulkScrape(internalUrls, {
  concurrency: 20,  // 20 parallel requests
  timeout: 5000     // 5 second timeout
});
```

### Method Selection

```javascript
// Force all URLs to use Puppeteer
const results = await bulkScrape(urls, {
  method: 'puppeteer',
  concurrency: 3  // Puppeteer is resource-intensive
});

// Force direct fetch for known static sites
const results = await bulkScrape(staticUrls, {
  method: 'direct',
  concurrency: 50  // Direct fetch can handle high concurrency
});
```

### Continue vs Stop on Error

```javascript
// Continue processing even if some URLs fail (default)
const results = await bulkScrape(urls, {
  continueOnError: true
});

// Stop immediately on first error
try {
  const results = await bulkScrape(urls, {
    continueOnError: false
  });
} catch (error) {
  console.error('Bulk scraping stopped due to error:', error);
}
```

## Error Handling

### Retry Failed URLs

```javascript
// First pass
const results = await bulkScrape(urls);

// Retry failures with different method
if (results.failed.length > 0) {
  const failedUrls = results.failed.map(f => f.url);
  const retryResults = await bulkScrape(failedUrls, {
    method: 'puppeteer',  // Try with full browser
    timeout: 60000        // Longer timeout
  });
}
```

### Custom Error Handling

```javascript
await bulkScrapeStream(urls, {
  onResult: (result) => {
    // Process successful results
  },
  onError: async (error) => {
    // Categorize and handle different error types
    if (error.error.includes('timeout')) {
      await logTimeoutError(error);
    } else if (error.error.includes('404')) {
      await handle404(error);
    } else {
      await logGeneralError(error);
    }
  }
});
```

## Performance Optimization

### Dynamic Concurrency

```javascript
// Start with low concurrency and increase based on success rate
let concurrency = 5;
const batchSize = 100;

for (let i = 0; i < urls.length; i += batchSize) {
  const batch = urls.slice(i, i + batchSize);
  
  const results = await bulkScrape(batch, { concurrency });
  
  const successRate = results.stats.successful / batch.length;
  
  // Adjust concurrency based on success rate
  if (successRate > 0.95) {
    concurrency = Math.min(concurrency + 2, 20);
  } else if (successRate < 0.8) {
    concurrency = Math.max(concurrency - 2, 2);
  }
  
  console.log(`Batch complete. Success rate: ${(successRate * 100).toFixed(1)}%. New concurrency: ${concurrency}`);
}
```

### Memory-Efficient Processing

```javascript
// Process in chunks to avoid memory issues
async function processLargeDataset(allUrls) {
  const chunkSize = 1000;
  const results = {
    successful: 0,
    failed: 0,
    totalTime: 0
  };
  
  for (let i = 0; i < allUrls.length; i += chunkSize) {
    const chunk = allUrls.slice(i, i + chunkSize);
    console.log(`Processing chunk ${i / chunkSize + 1} of ${Math.ceil(allUrls.length / chunkSize)}`);
    
    const chunkResults = await bulkScrape(chunk, {
      concurrency: 10,
      progressCallback: (p) => {
        const overallProgress = ((i + p.processed) / allUrls.length * 100).toFixed(1);
        console.log(`Overall progress: ${overallProgress}%`);
      }
    });
    
    results.successful += chunkResults.stats.successful;
    results.failed += chunkResults.stats.failed;
    results.totalTime += chunkResults.stats.totalTime;
    
    // Optional: Process results immediately to free memory
    await processChunkResults(chunkResults);
  }
  
  return results;
}
```

## Real-World Examples

### E-commerce Price Monitoring

```javascript
import { bulkScrapeStream } from '@monostate/node-scraper';

const productUrls = [
  'https://shop1.com/product/laptop-123',
  'https://shop2.com/items/laptop-123',
  // ... hundreds of product URLs
];

const priceData = [];

await bulkScrapeStream(productUrls, {
  concurrency: 5,
  onResult: async (result) => {
    // Extract price from scraped content
    const content = JSON.parse(result.content);
    const price = extractPrice(content);
    
    priceData.push({
      url: result.url,
      price: price,
      timestamp: result.timestamp
    });
  },
  progressCallback: (progress) => {
    process.stdout.write(`\rChecking prices: ${progress.percentage.toFixed(0)}%`);
  }
});

// Analyze price data
const avgPrice = priceData.reduce((sum, p) => sum + p.price, 0) / priceData.length;
console.log(`\nAverage price: $${avgPrice.toFixed(2)}`);
```

### News Aggregation

```javascript
import { bulkScrape } from '@monostate/node-scraper';

const newsUrls = [
  'https://news1.com/latest',
  'https://news2.com/today',
  'https://news3.com/breaking'
];

const results = await bulkScrape(newsUrls, {
  concurrency: 3,
  timeout: 10000
});

// Extract and combine articles
const allArticles = [];
results.success.forEach(result => {
  const content = JSON.parse(result.content);
  const articles = extractArticles(content);
  allArticles.push(...articles.map(a => ({
    ...a,
    source: new URL(result.url).hostname
  })));
});

// Sort by date and deduplicate
const uniqueArticles = deduplicateArticles(allArticles);
console.log(`Found ${uniqueArticles.length} unique articles`);
```

### SEO Analysis

```javascript
import { bulkScrape } from '@monostate/node-scraper';

async function analyzeSEO(urls) {
  const results = await bulkScrape(urls, {
    concurrency: 10,
    method: 'auto'
  });
  
  const seoData = results.success.map(result => {
    const content = JSON.parse(result.content);
    return {
      url: result.url,
      title: content.title,
      metaDescription: content.metaDescription,
      headings: content.headings,
      loadTime: result.duration,
      method: result.method,
      hasStructuredData: !!content.structuredData
    };
  });
  
  // Generate SEO report
  const avgLoadTime = seoData.reduce((sum, d) => sum + d.loadTime, 0) / seoData.length;
  const missingTitles = seoData.filter(d => !d.title).length;
  const missingDescriptions = seoData.filter(d => !d.metaDescription).length;
  
  return {
    totalAnalyzed: seoData.length,
    avgLoadTime: Math.round(avgLoadTime),
    missingTitles,
    missingDescriptions,
    details: seoData
  };
}
```

## Best Practices

### 1. Respect Rate Limits

```javascript
// Add delays between requests for external sites
async function respectfulBulkScrape(urls, delayMs = 1000) {
  const results = [];
  
  for (const url of urls) {
    const result = await smartScrape(url);
    results.push(result);
    
    // Wait before next request
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  
  return results;
}
```

### 2. Handle Different Content Types

```javascript
const results = await bulkScrape(mixedUrls, {
  progressCallback: (progress) => {
    console.log(`Processing: ${progress.current}`);
  }
});

// Separate different content types
const pdfResults = results.success.filter(r => r.contentType?.includes('pdf'));
const htmlResults = results.success.filter(r => !r.contentType?.includes('pdf'));

console.log(`Found ${pdfResults.length} PDFs and ${htmlResults.length} web pages`);
```

### 3. Monitor Resource Usage

```javascript
import { BNCASmartScraper } from '@monostate/node-scraper';
import browserPool from '@monostate/node-scraper/browser-pool.js';

const scraper = new BNCASmartScraper({ verbose: true });

// Monitor memory usage during bulk scraping
const memoryUsage = [];
const interval = setInterval(() => {
  memoryUsage.push(process.memoryUsage());
  
  // Log browser pool statistics
  const poolStats = browserPool.getStats();
  console.log('Browser Pool:', {
    active: poolStats.busyCount,
    idle: poolStats.idleCount,
    queued: poolStats.queueLength,
    totalCreated: poolStats.created,
    reused: poolStats.reused
  });
}, 1000);

try {
  const results = await scraper.bulkScrape(urls, {
    concurrency: 10,
    progressCallback: (p) => {
      const mem = process.memoryUsage();
      console.log(`Progress: ${p.percentage.toFixed(1)}% | Memory: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
    }
  });
} finally {
  clearInterval(interval);
  await scraper.cleanup();
}
```

### 4. Implement Circuit Breaker

```javascript
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED';
    this.nextAttempt = Date.now();
  }
  
  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

// Use with bulk scraping
const breaker = new CircuitBreaker();
const results = [];

for (const url of urls) {
  try {
    const result = await breaker.call(() => smartScrape(url));
    results.push(result);
  } catch (error) {
    console.error(`Failed to scrape ${url}: ${error.message}`);
  }
}
```

## Performance Tips

1. **Use appropriate concurrency**: Start with 5-10 concurrent requests and adjust based on performance
2. **Choose the right method**: Use `direct` for static sites, `puppeteer` for SPAs
3. **Stream large datasets**: Use `bulkScrapeStream` for datasets over 1000 URLs
4. **Monitor memory usage**: Process results immediately in streaming mode
5. **Implement retry logic**: Some failures are temporary
6. **Cache results**: Avoid re-scraping unchanged content
7. **Use timeouts**: Prevent hanging requests from blocking progress

## Troubleshooting

### High Memory Usage

If you experience high memory usage:

1. Reduce concurrency
2. Use streaming mode
3. Process results immediately
4. Call `cleanup()` periodically

### Slow Performance

If scraping is slow:

1. Increase concurrency (if server allows)
2. Use `direct` method when possible
3. Reduce timeout values
4. Check network connectivity

### Many Failures

If many URLs fail:

1. Check if sites require authentication
2. Verify URLs are correct
3. Use `puppeteer` method for JavaScript-heavy sites
4. Implement retry logic with backoff