// Type definitions for @bnca/smart-scraper
// Project: https://github.com/your-org/bnca-prototype
// Definitions by: BNCA Team

export interface ScrapingOptions {
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Number of retries per method */
  retries?: number;
  /** Enable detailed logging */
  verbose?: boolean;
  /** Path to Lightpanda binary */
  lightpandaPath?: string;
  /** Custom user agent string */
  userAgent?: string;
  /** BNCA API key for backend services */
  apiKey?: string;
  /** BNCA API URL (defaults to https://bnca-api.fly.dev) */
  apiUrl?: string;
  /** OpenRouter API key for AI processing */
  openRouterApiKey?: string;
  /** OpenAI API key for AI processing */
  openAIApiKey?: string;
  /** OpenAI base URL (for compatible endpoints) */
  openAIBaseUrl?: string;
  /** AI model to use */
  model?: string;
  /** AI temperature setting */
  temperature?: number;
  /** Maximum tokens for AI response */
  maxTokens?: number;
  /** HTTP referer for OpenRouter */
  referer?: string;
}

export interface ScrapingResult {
  /** Whether the scraping was successful */
  success: boolean;
  /** The extracted content as JSON string */
  content?: string;
  /** Raw HTML content (when available) */
  html?: string;
  /** Size of the content in bytes */
  size?: number;
  /** Method used for scraping */
  method: 'direct-fetch' | 'lightpanda' | 'puppeteer' | 'chrome-screenshot' | 'quickshot' | 'failed' | 'error';
  /** Whether browser rendering was needed */
  needsBrowser?: boolean;
  /** Content type from response headers */
  contentType?: string;
  /** Error message if scraping failed */
  error?: string;
  /** Base64 encoded screenshot (if captured) */
  screenshot?: string;
  /** Performance metrics */
  performance: {
    /** Total time taken in milliseconds */
    totalTime: number;
    /** Method used for scraping */
    method?: string;
    /** System metrics (if available) */
    systemMetrics?: SystemMetrics;
  };
  /** Browser requirement indicators */
  browserIndicators?: string[];
  /** Performance statistics */
  stats?: ScrapingStats;
}

export interface SystemMetrics {
  /** Duration of monitoring in milliseconds */
  duration?: number;
  /** Number of samples collected */
  samples?: number;
  /** Memory usage statistics */
  memory?: {
    heapUsed: MetricStats;
    rss: MetricStats;
  };
  /** CPU usage statistics */
  cpu?: MetricStats;
  /** System memory usage */
  systemMemory?: MetricStats;
  /** Error message if metrics collection failed */
  error?: string;
}

export interface MetricStats {
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Average value */
  avg: number;
  /** Peak value */
  peak?: number;
}

export interface ScrapingStats {
  /** Direct fetch statistics */
  directFetch: MethodStats;
  /** Lightpanda statistics */
  lightpanda: MethodStats;
  /** Puppeteer statistics */
  puppeteer: MethodStats;
  /** Success rates for each method */
  successRates: {
    directFetch: string;
    lightpanda: string;
    puppeteer: string;
  };
}

export interface MethodStats {
  /** Number of attempts */
  attempts: number;
  /** Number of successes */
  successes: number;
}

export interface HealthCheckResult {
  /** Overall health status */
  status: 'healthy' | 'unhealthy';
  /** Availability of each method */
  methods: {
    directFetch: boolean;
    lightpanda: boolean;
    puppeteer: boolean;
  };
  /** Timestamp of health check */
  timestamp: string;
}

/**
 * BNCA Smart Scraper - Intelligent web scraping with multi-level fallback
 */
export class BNCASmartScraper {
  /**
   * Create a new BNCA Smart Scraper instance
   * @param options Configuration options
   */
  constructor(options?: ScrapingOptions);

  /**
   * Scrape a URL with intelligent fallback system
   * @param url The URL to scrape
   * @param options Optional configuration overrides
   * @returns Promise resolving to scraping result
   */
  scrape(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;

  /**
   * Take a screenshot of a webpage
   * @param url The URL to capture
   * @param options Optional configuration overrides
   * @returns Promise resolving to screenshot result
   */
  screenshot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;

  /**
   * Quick screenshot capture - optimized for speed
   * @param url The URL to capture
   * @param options Optional configuration overrides
   * @returns Promise resolving to screenshot result
   */
  quickshot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
  
  /**
   * Ask AI a question about a URL
   * @param url The URL to analyze
   * @param question The question to answer about the page
   * @param options Optional configuration overrides
   * @returns Promise resolving to AI answer
   */
  askAI(url: string, question: string, options?: ScrapingOptions): Promise<{
    success: boolean;
    answer?: string;
    error?: string;
    method?: string;
    scrapeTime?: number;
    processing?: 'openrouter' | 'openai' | 'backend' | 'local';
  }>;

  /**
   * Get performance statistics for all methods
   * @returns Current statistics
   */
  getStats(): ScrapingStats;

  /**
   * Perform health check on all scraping methods
   * @returns Promise resolving to health status
   */
  healthCheck(): Promise<HealthCheckResult>;

  /**
   * Clean up resources (browser instances, etc.)
   * @returns Promise that resolves when cleanup is complete
   */
  cleanup(): Promise<void>;

  /**
   * Try direct HTTP fetch method
   * @param url URL to fetch
   * @param config Configuration options
   * @returns Promise resolving to scraping result
   */
  private tryDirectFetch(url: string, config: ScrapingOptions): Promise<ScrapingResult>;

  /**
   * Try Lightpanda browser method
   * @param url URL to scrape
   * @param config Configuration options
   * @returns Promise resolving to scraping result
   */
  private tryLightpanda(url: string, config: ScrapingOptions): Promise<ScrapingResult>;

  /**
   * Try Puppeteer browser method
   * @param url URL to scrape
   * @param config Configuration options
   * @returns Promise resolving to scraping result
   */
  private tryPuppeteer(url: string, config: ScrapingOptions): Promise<ScrapingResult>;

  /**
   * Detect if a site requires browser rendering
   * @param html HTML content to analyze
   * @param url Original URL for context
   * @returns Whether browser rendering is needed
   */
  private detectBrowserRequirement(html: string, url: string): boolean;

  /**
   * Extract structured content from HTML
   * @param html Raw HTML content
   * @returns Extracted content as JSON string
   */
  private extractContentFromHTML(html: string): string;

  /**
   * Find Lightpanda binary on the system
   * @returns Path to binary or null if not found
   */
  private findLightpandaBinary(): string | null;

  /**
   * Get browser requirement indicators for debugging
   * @param html HTML content to analyze
   * @returns Array of detected indicators
   */
  private getBrowserIndicators(html: string): string[];

  /**
   * Log a message if verbose mode is enabled
   * @param message Message to log
   */
  private log(message: string): void;
}

/**
 * Convenience function for quick web scraping
 * @param url The URL to scrape
 * @param options Optional configuration
 * @returns Promise resolving to scraping result
 */
export function smartScrape(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;

/**
 * Convenience function for taking screenshots
 * @param url The URL to capture
 * @param options Optional configuration
 * @returns Promise resolving to screenshot result
 */
export function smartScreenshot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;

/**
 * Convenience function for quick screenshot capture
 * @param url The URL to capture
 * @param options Optional configuration
 * @returns Promise resolving to screenshot result
 */
export function quickShot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;

/**
 * Convenience function for asking AI questions about a webpage
 * @param url The URL to analyze
 * @param question The question to answer
 * @param options Optional configuration
 * @returns Promise resolving to AI answer
 */
export function askWebsiteAI(url: string, question: string, options?: ScrapingOptions): Promise<{
  success: boolean;
  answer?: string;
  error?: string;
  method?: string;
  scrapeTime?: number;
  processing?: 'openrouter' | 'openai' | 'backend' | 'local';
}>;

/**
 * Default export - same as BNCASmartScraper class
 */
export default BNCASmartScraper;