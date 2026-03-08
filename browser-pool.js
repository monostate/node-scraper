class BrowserPool {
    constructor(maxInstances = 3, idleTimeout = 5000) {
        this.maxInstances = maxInstances;
        this.idleTimeout = idleTimeout;
        this.pool = [];
        this.busyBrowsers = new Set();
        this.cleanupTimer = null;
        this.requestQueue = [];
        this.stats = {
            created: 0,
            reused: 0,
            queued: 0,
            cleaned: 0
        };
    }

    async getBrowser() {
        // Try to get an idle browser from pool
        let browser = this.pool.find(b => !this.busyBrowsers.has(b.instance));
        
        if (browser) {
            browser.lastUsed = Date.now();
            this.busyBrowsers.add(browser.instance);
            this.stats.reused++;
            return browser.instance;
        }

        // Create new browser if under limit
        if (this.pool.length < this.maxInstances) {
            browser = await this.createBrowser();
            this.pool.push(browser);
            this.busyBrowsers.add(browser.instance);
            this.stats.created++;
            return browser.instance;
        }

        // Queue the request and wait for available browser
        this.stats.queued++;
        return this.queueRequest();
    }

    async createBrowser() {
        const puppeteer = await this.getPuppeteer();
        const instance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run'
            ]
        });

        const browser = {
            instance,
            created: Date.now(),
            lastUsed: Date.now(),
            pageCount: 0
        };

        // Handle browser disconnect
        instance.on('disconnected', () => {
            this.removeBrowser(browser);
            this.processQueue();
        });

        return browser;
    }

    async getPuppeteer() {
        try {
            const puppeteer = await import('puppeteer');
            return puppeteer.default || puppeteer;
        } catch (error) {
            throw new Error('Puppeteer is not installed. Please install it to use Puppeteer-based scraping.');
        }
    }

    async queueRequest() {
        return new Promise((resolve) => {
            this.requestQueue.push({ resolve, timestamp: Date.now() });
        });
    }

    processQueue() {
        if (this.requestQueue.length === 0) return;

        // Find available browser
        const available = this.pool.find(b => !this.busyBrowsers.has(b.instance));
        if (!available) return;

        // Process oldest request in queue
        const request = this.requestQueue.shift();
        if (request) {
            available.lastUsed = Date.now();
            this.busyBrowsers.add(available.instance);
            request.resolve(available.instance);
        }
    }

    releaseBrowser(browser) {
        this.busyBrowsers.delete(browser);
        
        // Process any queued requests
        this.processQueue();
        
        // Start cleanup timer if not already running
        if (!this.cleanupTimer) {
            this.cleanupTimer = setTimeout(() => this.cleanup(), this.idleTimeout);
        }
    }

    removeBrowser(browserObj) {
        const index = this.pool.findIndex(b => b.instance === browserObj.instance);
        if (index !== -1) {
            this.pool.splice(index, 1);
            this.busyBrowsers.delete(browserObj.instance);
        }
    }

    async cleanup() {
        this.cleanupTimer = null;
        const now = Date.now();
        const toRemove = [];

        // Keep at least one browser if there are queued requests
        const minBrowsers = this.requestQueue.length > 0 ? 1 : 0;

        for (const browser of this.pool) {
            // Skip if we need to keep minimum browsers
            if (this.pool.length - toRemove.length <= minBrowsers) break;
            
            // Remove idle browsers
            const isIdle = !this.busyBrowsers.has(browser.instance);
            const idleTime = now - browser.lastUsed;
            
            if (isIdle && idleTime > this.idleTimeout) {
                toRemove.push(browser);
            }
        }

        // Close idle browsers
        for (const browser of toRemove) {
            try {
                // Check if browser is still connected
                if (browser.instance && browser.instance.isConnected()) {
                    await browser.instance.close();
                }
                this.removeBrowser(browser);
                this.stats.cleaned++;
            } catch (error) {
                // Silently ignore protocol errors and disconnection errors
                if (!error.message.includes('Protocol error') && 
                    !error.message.includes('Target closed') &&
                    !error.message.includes('Connection closed')) {
                    console.warn('Error closing browser:', error.message);
                }
                // Remove browser even if close failed
                this.removeBrowser(browser);
            }
        }

        // Schedule next cleanup if there are still browsers
        if (this.pool.length > 0) {
            this.cleanupTimer = setTimeout(() => this.cleanup(), this.idleTimeout);
        }
    }

    async closeAll() {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // Clear the queue
        this.requestQueue = [];

        const closePromises = this.pool.map(async (browser) => {
            try {
                // Check if browser is still connected
                if (browser.instance && browser.instance.isConnected()) {
                    await browser.instance.close();
                }
            } catch (error) {
                // Silently ignore protocol errors and disconnection errors
                if (!error.message.includes('Protocol error') && 
                    !error.message.includes('Target closed') &&
                    !error.message.includes('Connection closed')) {
                    console.warn('Error closing browser:', error.message);
                }
            }
        });

        await Promise.all(closePromises);
        this.pool = [];
        this.busyBrowsers.clear();
    }

    getStats() {
        return {
            ...this.stats,
            poolSize: this.pool.length,
            busyCount: this.busyBrowsers.size,
            idleCount: this.pool.length - this.busyBrowsers.size,
            queueLength: this.requestQueue.length
        };
    }
}

// Global browser pool instance
const browserPool = new BrowserPool(3, 5000);

// Graceful shutdown
process.on('SIGTERM', () => browserPool.closeAll());
process.on('SIGINT', () => browserPool.closeAll());
process.on('beforeExit', () => browserPool.closeAll());

export default browserPool;