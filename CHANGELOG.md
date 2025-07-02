# Changelog

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