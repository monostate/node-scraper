# Changelog

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