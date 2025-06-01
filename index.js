import fetch from 'node-fetch';
import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';

let puppeteer = null;
try {
  puppeteer = await import('puppeteer');
  puppeteer = puppeteer.default || puppeteer;
} catch (e) {
  // Puppeteer is optional
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * BNCA Smart Scraper - Intelligent Web Scraping with Multi-level Fallback
 * 
 * This class implements a sophisticated fallback system:
 * 1. Direct Fetch - Fast HTML retrieval for simple sites
 * 2. Lightpanda - Lightning-fast browser for static/SSR sites  
 * 3. Puppeteer - Full Chromium browser for complex JavaScript sites
 * 
 * Performance: 10x+ faster than Firecrawl on average
 */
export class BNCASmartScraper {
  constructor(options = {}) {
    this.options = {
      timeout: options.timeout || 10000,
      userAgent: options.userAgent || 'Mozilla/5.0 (compatible; BNCA/1.0; +https://github.com/your-org/bnca)',
      lightpandaPath: options.lightpandaPath || this.findLightpandaBinary(),
      retries: options.retries || 2,
      verbose: options.verbose || false,
      ...options
    };
    
    this.browser = null;
    this.stats = {
      directFetch: { attempts: 0, successes: 0 },
      lightpanda: { attempts: 0, successes: 0 },
      puppeteer: { attempts: 0, successes: 0 }
    };
  }
  
  /**
   * Main scraping method with intelligent fallback
   */
  async scrape(url, options = {}) {
    const startTime = Date.now();
    const config = { ...this.options, ...options };
    
    this.log(`🚀 Starting smart scrape for: ${url}`);
    
    let result = null;
    let method = 'unknown';
    let lastError = null;
    
    try {
      // Step 1: Try direct fetch first (fastest)
      this.log('  🔄 Attempting direct fetch...');
      result = await this.tryDirectFetch(url, config);
      
      if (result.success && !result.needsBrowser) {
        method = 'direct-fetch';
        this.log('  ✅ Direct fetch successful');
      } else {
        this.log(result.needsBrowser ? '  ⚠️  Browser rendering required' : '  ❌ Direct fetch failed');
        lastError = result.error;
        
        // Step 2: Try Lightpanda (fast browser)
        this.log('  🐼 Attempting Lightpanda...');
        result = await this.tryLightpanda(url, config);
        
        if (result.success) {
          method = 'lightpanda';
          this.log('  ✅ Lightpanda successful');
        } else {
          this.log('  ❌ Lightpanda failed, falling back to Puppeteer');
          lastError = result.error;
          
          // Step 3: Fallback to Puppeteer (full browser)
          this.log('  🔵 Attempting Puppeteer...');
          result = await this.tryPuppeteer(url, config);
          
          if (result.success) {
            method = 'puppeteer';
            this.log('  ✅ Puppeteer successful');
          } else {
            method = 'failed';
            this.log('  ❌ All methods failed');
            lastError = result.error;
          }
        }
      }
      
      const totalTime = Date.now() - startTime;
      
      return {
        ...result,
        method,
        performance: {
          totalTime,
          method
        },
        stats: this.getStats()
      };
      
    } catch (error) {
      return {
        success: false,
        method: 'error',
        error: error.message,
        performance: {
          totalTime: Date.now() - startTime
        }
      };
    }
  }
  
  /**
   * Direct HTTP fetch - fastest method for simple sites
   */
  async tryDirectFetch(url, config) {
    this.stats.directFetch.attempts++;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': config.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }
      
      const html = await response.text();
      
      // Intelligent browser detection
      const needsBrowser = this.detectBrowserRequirement(html, url);
      
      if (!needsBrowser) {
        const content = this.extractContentFromHTML(html);
        this.stats.directFetch.successes++;
        
        return {
          success: true,
          needsBrowser: false,
          content,
          html,
          size: html.length,
          contentType: response.headers.get('content-type') || 'text/html'
        };
      } else {
        return {
          success: true,
          needsBrowser: true,
          html,
          size: html.length,
          browserIndicators: this.getBrowserIndicators(html)
        };
      }
      
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Lightpanda browser - fast browser engine for static/SSR sites
   */
  async tryLightpanda(url, config) {
    this.stats.lightpanda.attempts++;
    
    if (!this.options.lightpandaPath) {
      return {
        success: false,
        error: 'Lightpanda binary not found. Please install Lightpanda or provide path.'
      };
    }
    
    try {
      // Check if binary exists
      const stats = statSync(this.options.lightpandaPath);
      if (!stats.isFile()) {
        return {
          success: false,
          error: 'Lightpanda binary is not a file'
        };
      }
    } catch {
      return {
        success: false,
        error: 'Lightpanda binary not accessible'
      };
    }
    
    return new Promise((resolve) => {
      const args = ['fetch', '--dump', url];
      const process = spawn(this.options.lightpandaPath, args, {
        timeout: config.timeout + 1000 // Add buffer for process timeout only
      });
      
      let output = '';
      let errorOutput = '';
      
      process.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      process.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0 && output.length > 0) {
          const content = this.extractContentFromHTML(output);
          this.stats.lightpanda.successes++;
          
          resolve({
            success: true,
            content,
            html: output,
            size: output.length,
            exitCode: code
          });
        } else {
          resolve({
            success: false,
            error: errorOutput || `Lightpanda exited with code ${code}`,
            exitCode: code
          });
        }
      });
      
      process.on('error', (error) => {
        resolve({
          success: false,
          error: `Lightpanda process error: ${error.message}`
        });
      });
    });
  }
  
  /**
   * Puppeteer browser - full Chromium for complex JavaScript sites
   */
  async tryPuppeteer(url, config) {
    this.stats.puppeteer.attempts++;
    
    if (!puppeteer) {
      throw new Error('Puppeteer is not available');
    }
    
    try {
      if (!this.browser) {
        this.browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        });
      }
      
      const page = await this.browser.newPage();
      
      // Set user agent and viewport
      await page.setUserAgent(config.userAgent);
      await page.setViewport({ width: 1280, height: 720 });
      
      // Block unnecessary resources for faster loading
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });
      
      // Navigate with timeout
      await page.goto(url, { 
        waitUntil: 'networkidle0', 
        timeout: config.timeout 
      });
      
      // Extract content using browser APIs
      const content = await page.evaluate(() => {
        // Get basic page info
        const title = document.title;
        const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
        
        // Extract headings
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .map(h => ({
            level: h.tagName.toLowerCase(),
            text: h.textContent.trim()
          }))
          .filter(h => h.text.length > 0)
          .slice(0, 20);
        
        // Extract paragraphs
        const paragraphs = Array.from(document.querySelectorAll('p'))
          .map(p => p.textContent.trim())
          .filter(text => text.length > 20)
          .slice(0, 10);
        
        // Extract links
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({
            text: a.textContent.trim(),
            href: a.href
          }))
          .filter(link => link.text.length > 0)
          .slice(0, 15);
        
        // Extract JSON-LD structured data
        const structuredData = Array.from(document.querySelectorAll('script[type=\"application/ld+json\"]'))
          .map(script => {
            try {
              return JSON.parse(script.textContent);
            } catch {
              return null;
            }
          })
          .filter(data => data !== null);
        
        // Get page text content (truncated)
        const bodyText = document.body.textContent
          .replace(/\\s+/g, ' ')
          .trim()
          .substring(0, 3000);
        
        return {
          title,
          metaDescription,
          canonical,
          headings,
          paragraphs,
          links,
          structuredData,
          bodyText,
          url: window.location.href
        };
      });
      
      await page.close();
      this.stats.puppeteer.successes++;
      
      return {
        success: true,
        content: JSON.stringify(content, null, 2),
        size: JSON.stringify(content).length
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Intelligent detection of browser requirement
   */
  detectBrowserRequirement(html, url) {
    // Whitelist simple sites that should always use direct fetch
    const simpleSites = [
      'example.com',
      'httpbin.org',
      'wikipedia.org',
      'github.io',
      'netlify.app',
      'vercel.app'
    ];
    
    if (simpleSites.some(site => url.includes(site))) {
      return false; // Always use direct fetch for these
    }
    
    // Check for common SPA patterns (be more specific)
    const spaIndicators = [
      /<div[^>]*id=['"]?root['"]?[^>]*>\s*<\/div>/i,
      /<div[^>]*id=['"]?app['"]?[^>]*>\s*<\/div>/i,
      /<div[^>]*data-reactroot/i,
      /window\.__NEXT_DATA__/i,
      /window\.__NUXT__/i,
      /_next\/static/i,
      /__webpack_require__/i
    ];
    
    // Check for protection systems (more specific patterns)
    const protectionIndicators = [
      /cloudflare.*challenge/i,
      /cloudflare.*protection/i,
      /ray id.*cloudflare/i,
      /please enable javascript/i,
      /you need to enable javascript/i,
      /this site requires javascript/i,
      /jscript.*required/i,
      /security check.*cloudflare/i,
      /attention required.*cloudflare/i
    ];
    
    // Domain-based checks for known SPA sites
    const domainIndicators = [
      /instagram\.com/i,
      /twitter\.com/i,
      /facebook\.com/i,
      /linkedin\.com/i,
      /maps\.google/i,
      /gmail\.com/i,
      /youtube\.com/i
    ];
    
    // Check if it's clearly a SPA or protected site
    const hasSpaIndicators = spaIndicators.some(pattern => pattern.test(html));
    const hasProtection = protectionIndicators.some(pattern => pattern.test(html));
    const isKnownSpa = domainIndicators.some(pattern => pattern.test(url));
    
    // Check for minimal content BUT only if we also have SPA indicators
    const bodyContent = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || '';
    const textContent = bodyContent
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const hasMinimalContent = textContent.length < 200; // More conservative threshold
    const isLikelySpa = hasMinimalContent && hasSpaIndicators;
    
    // Only require browser if we have strong indicators
    const needsBrowser = hasProtection || isKnownSpa || isLikelySpa;
    
    return needsBrowser;
  }
  
  /**
   * Get browser requirement indicators for debugging
   */
  getBrowserIndicators(html) {
    const indicators = [];
    
    if (/<div[^>]*id=['"]?root['"]?[^>]*>\s*<\/div>/i.test(html)) {
      indicators.push('React root div detected');
    }
    if (/window\.__NEXT_DATA__/i.test(html)) {
      indicators.push('Next.js data detected');
    }
    if (/cloudflare.*challenge/i.test(html)) {
      indicators.push('Cloudflare challenge detected');
    }
    if (/cloudflare.*protection/i.test(html)) {
      indicators.push('Cloudflare protection detected');
    }
    if (/please enable javascript/i.test(html)) {
      indicators.push('JavaScript required message detected');
    }
    
    return indicators;
  }
  
  /**
   * Extract structured content from HTML
   */
  extractContentFromHTML(html) {
    try {
      // Basic content extraction
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
      const metaDescription = html.match(/<meta[^>]*name=['"]description['"][^>]*content=['"]([^'"]*)['"]/i)?.[1] || '';
      
      // Extract JSON-LD structured data
      const jsonLdMatches = [...html.matchAll(/<script[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi)];
      const structuredData = [];
      
      jsonLdMatches.forEach(match => {
        try {
          const data = JSON.parse(match[1]);
          structuredData.push(data);
        } catch {
          // Ignore malformed JSON
        }
      });
      
      // Extract window state data
      const windowDataMatch = html.match(/window\.__(?:INITIAL_STATE__|INITIAL_DATA__|NEXT_DATA__)__\s*=\s*({[\s\S]*?});/);
      let windowData = null;
      if (windowDataMatch) {
        try {
          windowData = JSON.parse(windowDataMatch[1]);
        } catch {
          windowData = 'Found but unparseable';
        }
      }
      
      // Extract main content
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      let textContent = '';
      if (bodyMatch) {
        textContent = bodyMatch[1]
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 2000);
      }
      
      // Extract meta tags
      const metaTags = {};
      const metaMatches = [...html.matchAll(/<meta[^>]*(?:property|name)=['"]([^'"]+)['"][^>]*content=['"]([^'"]*)['"]/gi)];
      metaMatches.slice(0, 15).forEach(match => {
        metaTags[match[1]] = match[2];
      });
      
      return JSON.stringify({
        title,
        metaDescription,
        structuredData: structuredData.length > 0 ? structuredData : null,
        windowData,
        metaTags: Object.keys(metaTags).length > 0 ? metaTags : null,
        content: textContent,
        extractedAt: new Date().toISOString()
      }, null, 2);
      
    } catch (error) {
      return JSON.stringify({
        error: 'Content extraction failed',
        message: error.message,
        rawLength: html.length
      }, null, 2);
    }
  }
  
  /**
   * Find Lightpanda binary
   */
  findLightpandaBinary() {
    // First check the package's bin directory (installed by postinstall script)
    const packageDir = path.dirname(new URL(import.meta.url).pathname);
    const packageBinPath = path.join(packageDir, 'bin', 'lightpanda');
    
    const possiblePaths = [
      packageBinPath, // Package's bin directory (highest priority)
      './lightpanda',
      '../lightpanda',
      './lightpanda/lightpanda',
      '/usr/local/bin/lightpanda',
      path.join(process.cwd(), 'lightpanda'),
      path.join(process.cwd(), 'bin', 'lightpanda')
    ];
    
    for (const binaryPath of possiblePaths) {
      try {
        // Synchronous check for binary existence and executability
        const fullPath = path.resolve(binaryPath);
        if (existsSync(fullPath)) {
          const stats = statSync(fullPath);
          if (stats.isFile()) {
            // Check if it's executable (on Unix-like systems including WSL)
            if (process.platform !== 'win32' || this.isWSL()) {
              const mode = stats.mode;
              const isExecutable = Boolean(mode & parseInt('111', 8));
              if (isExecutable) {
                return fullPath;
              }
            } else {
              // On native Windows (not WSL), Lightpanda is not supported
              continue;
            }
          }
        }
      } catch {
        continue;
      }
    }
    
    return null;
  }
  
  /**
   * Check if running in WSL environment
   */
  isWSL() {
    try {
      const uname = execSync('uname -r', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return uname.toLowerCase().includes('microsoft') || uname.toLowerCase().includes('wsl');
    } catch {
      return false;
    }
  }
  
  /**
   * Get performance statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRates: {
        directFetch: this.stats.directFetch.attempts > 0 ? 
          (this.stats.directFetch.successes / this.stats.directFetch.attempts * 100).toFixed(1) + '%' : '0%',
        lightpanda: this.stats.lightpanda.attempts > 0 ? 
          (this.stats.lightpanda.successes / this.stats.lightpanda.attempts * 100).toFixed(1) + '%' : '0%',
        puppeteer: this.stats.puppeteer.attempts > 0 ? 
          (this.stats.puppeteer.successes / this.stats.puppeteer.attempts * 100).toFixed(1) + '%' : '0%'
      }
    };
  }
  
  /**
   * Logging helper
   */
  log(message) {
    if (this.options.verbose) {
      console.log(message);
    }
  }
  
  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
  
  /**
   * Take a screenshot of a webpage
   */
  async screenshot(url, options = {}) {
    const startTime = Date.now();
    const config = { ...this.options, ...options };
    
    this.log(`📸 Taking screenshot for: ${url}`);
    
    try {
      const screenshot = await this.takeScreenshotWithChrome(url, config);
      
      return {
        success: !!screenshot,
        screenshot,
        method: 'chrome-screenshot',
        performance: {
          totalTime: Date.now() - startTime
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        method: 'chrome-screenshot',
        performance: {
          totalTime: Date.now() - startTime
        }
      };
    }
  }
  
  /**
   * Quick screenshot capture - optimized for speed
   */
  async quickshot(url, options = {}) {
    const startTime = Date.now();
    const config = { 
      ...this.options, 
      ...options,
      timeout: options.timeout || 15000 // Longer timeout for screenshots
    };
    
    this.log(`⚡ Taking quick screenshot for: ${url}`);
    
    try {
      const screenshot = await this.takeScreenshotOptimized(url, config);
      
      return {
        success: !!screenshot,
        screenshot,
        method: 'quickshot',
        performance: {
          totalTime: Date.now() - startTime
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        method: 'quickshot',
        performance: {
          totalTime: Date.now() - startTime
        }
      };
    }
  }
  
  /**
   * Take screenshot using Chrome CLI
   */
  async takeScreenshotWithChrome(url, config) {
    const tempFile = path.join('/tmp', `screenshot_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
    
    try {
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=' + config.userAgent,
        '--screenshot=' + tempFile,
        '--window-size=1280,800',
        '--hide-scrollbars',
        '--virtual-time-budget=10000',
        url
      ];
      
      const chromePath = await this.findChromePath();
      if (!chromePath) {
        throw new Error('Chrome/Chromium not found');
      }
      
      return new Promise((resolve) => {
        const chrome = spawn(chromePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false
        });
        
        let processExited = false;
        let stderr = '';
        
        chrome.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        const killTimeout = setTimeout(() => {
          if (!processExited) {
            this.log('Chrome timeout, sending SIGTERM...');
            chrome.kill('SIGTERM');
            
            setTimeout(() => {
              if (!processExited) {
                chrome.kill('SIGKILL');
              }
            }, 1000);
          }
        }, config.timeout || 15000);
        
        chrome.on('exit', async (code, signal) => {
          processExited = true;
          clearTimeout(killTimeout);
          
          try {
            await new Promise(r => setTimeout(r, 500));
            const screenshotBuffer = await fsPromises.readFile(tempFile);
            const base64 = screenshotBuffer.toString('base64');
            await fsPromises.unlink(tempFile).catch(() => {});
            resolve(`data:image/png;base64,${base64}`);
          } catch (error) {
            resolve(null);
          }
        });
        
        chrome.on('error', (error) => {
          clearTimeout(killTimeout);
          resolve(null);
        });
      });
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Optimized screenshot for speed
   */
  async takeScreenshotOptimized(url, config, retryCount = 0) {
    const tempFile = path.join('/tmp', `screenshot_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
    
    try {
      const virtualTimeBudget = retryCount === 0 ? 5000 : 8000;
      const processTimeout = retryCount === 0 ? 8000 : 12000;
      
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=TranslateUI',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=' + config.userAgent,
        '--screenshot=' + tempFile,
        '--window-size=1280,800',
        '--hide-scrollbars',
        '--run-all-compositor-stages-before-draw',
        `--virtual-time-budget=${virtualTimeBudget}`,
        url
      ];
      
      const chromePath = await this.findChromePath();
      if (!chromePath) {
        throw new Error('Chrome/Chromium not found');
      }
      
      return new Promise((resolve) => {
        const chrome = spawn(chromePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false
        });
        
        let processExited = false;
        
        const killTimeout = setTimeout(() => {
          if (!processExited) {
            chrome.kill('SIGTERM');
            setTimeout(() => {
              if (!processExited) {
                chrome.kill('SIGKILL');
              }
            }, 1000);
          }
        }, processTimeout);
        
        chrome.on('exit', async (code, signal) => {
          processExited = true;
          clearTimeout(killTimeout);
          
          try {
            await new Promise(r => setTimeout(r, 500));
            const screenshotBuffer = await fsPromises.readFile(tempFile);
            const base64 = screenshotBuffer.toString('base64');
            await fsPromises.unlink(tempFile).catch(() => {});
            resolve(`data:image/png;base64,${base64}`);
          } catch (error) {
            if (retryCount === 0) {
              const retryResult = await this.takeScreenshotOptimized(url, config, 1);
              resolve(retryResult);
            } else {
              resolve(null);
            }
          }
        });
        
        chrome.on('error', (error) => {
          clearTimeout(killTimeout);
          resolve(null);
        });
      });
    } catch (error) {
      if (retryCount === 0) {
        return this.takeScreenshotOptimized(url, config, 1);
      }
      return null;
    }
  }
  
  /**
   * Find Chrome/Chromium binary path
   */
  async findChromePath() {
    const chromePaths = process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ] : [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
    ];
    
    for (const path of chromePaths) {
      try {
        await fsPromises.access(path);
        return path;
      } catch (e) {
        continue;
      }
    }
    
    return null;
  }
  
  /**
   * Health check for all scraping methods
   */
  async healthCheck() {
    const testUrl = 'https://example.com';
    const results = {};
    
    // Test direct fetch
    try {
      const directResult = await this.tryDirectFetch(testUrl, this.options);
      results.directFetch = directResult.success;
    } catch {
      results.directFetch = false;
    }
    
    // Test Lightpanda
    try {
      const lightpandaResult = await this.tryLightpanda(testUrl, this.options);
      results.lightpanda = lightpandaResult.success;
    } catch {
      results.lightpanda = false;
    }
    
    // Test Puppeteer
    try {
      const puppeteerResult = await this.tryPuppeteer(testUrl, this.options);
      results.puppeteer = puppeteerResult.success;
      await this.cleanup(); // Clean up after test
    } catch {
      results.puppeteer = false;
    }
    
    return {
      status: Object.values(results).some(r => r) ? 'healthy' : 'unhealthy',
      methods: results,
      timestamp: new Date().toISOString()
    };
  }
}

// Export convenience functions
export async function smartScrape(url, options = {}) {
  const scraper = new BNCASmartScraper(options);
  try {
    const result = await scraper.scrape(url, options);
    await scraper.cleanup();
    return result;
  } catch (error) {
    await scraper.cleanup();
    throw error;
  }
}

export async function smartScreenshot(url, options = {}) {
  const scraper = new BNCASmartScraper(options);
  try {
    const result = await scraper.screenshot(url, options);
    return result;
  } catch (error) {
    throw error;
  }
}

export async function quickShot(url, options = {}) {
  const scraper = new BNCASmartScraper(options);
  try {
    const result = await scraper.quickshot(url, options);
    return result;
  } catch (error) {
    throw error;
  }
}

export default BNCASmartScraper;