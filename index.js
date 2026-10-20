import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';
let PDFParse = null;
import { EventEmitter } from 'events';
import browserPool from './browser-pool.js';
import { findChromePath } from './chrome-path.js';
import { classifyContent, stripHtmlToText, CONTENT_STATUS } from './content-status.js';
import { Trace } from './telemetry.js';
import { Deadline } from './deadline.js';

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
export class BNCASmartScraper extends EventEmitter {
  constructor(options = {}) {
    super();
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
      puppeteer: { attempts: 0, successes: 0 },
      pdf: { attempts: 0, successes: 0 }
    };
  }
  
  /**
   * Ask AI a question about a URL
   * Scrapes the URL and uses AI to answer the question
   * 
   * @param {string} url - URL to analyze
   * @param {string} question - Question to answer
   * @param {object} options - Additional options
   * @returns {Promise<object>} AI response with answer
   */
  async askAI(url, question, options = {}) {
    try {
      // First scrape the content
      const scrapeResult = await this.scrape(url, options);
      
      if (!scrapeResult.success) {
        return {
          success: false,
          error: `Failed to scrape URL: ${scrapeResult.error}`,
          method: scrapeResult.method
        };
      }
      
      // Check for OpenRouter/OpenAI API key
      const openRouterKey = options.openRouterApiKey || this.options.openRouterApiKey || process.env.OPENROUTER_API_KEY;
      const openAIKey = options.openAIApiKey || this.options.openAIApiKey || process.env.OPENAI_API_KEY;
      
      // Priority: OpenRouter > OpenAI > Backend API > Local
      if (openRouterKey) {
        try {
          const answer = await this.processWithOpenRouter(question, scrapeResult.content, openRouterKey, options);
          return {
            success: true,
            answer,
            method: scrapeResult.method,
            scrapeTime: scrapeResult.stats.totalTime,
            processing: 'openrouter'
          };
        } catch (error) {
          this.log('  ⚠️ OpenRouter API call failed, falling back...');
        }
      }
      
      if (openAIKey) {
        try {
          const answer = await this.processWithOpenAI(question, scrapeResult.content, openAIKey, options);
          return {
            success: true,
            answer,
            method: scrapeResult.method,
            scrapeTime: scrapeResult.stats.totalTime,
            processing: 'openai'
          };
        } catch (error) {
          this.log('  ⚠️ OpenAI API call failed, falling back...');
        }
      }
      
      // If BNCA API key is provided, use the backend API
      if (this.options.apiKey) {
        try {
          const response = await fetch(`${this.options.apiUrl || 'https://bnca-api.fly.dev'}/aireply`, {
            method: 'POST',
            headers: {
              'x-api-key': this.options.apiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url, question })
          });
          
          if (response.ok) {
            const data = await response.json();
            return {
              success: true,
              answer: data.answer,
              method: scrapeResult.method,
              scrapeTime: scrapeResult.stats.totalTime,
              processing: 'backend'
            };
          }
        } catch (error) {
          this.log('  ⚠️ Backend API call failed, using local AI processing');
        }
      }
      
      // Local AI processing fallback
      const answer = this.processLocally(question, scrapeResult.content);
      
      return {
        success: true,
        answer,
        method: scrapeResult.method,
        scrapeTime: scrapeResult.stats.totalTime,
        processing: 'local'
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message || 'AI processing failed'
      };
    }
  }
  
  /**
   * Process with OpenRouter API
   * @private
   */
  async processWithOpenRouter(question, content, apiKey, options = {}) {
    const parsedContent = typeof content === 'string' ? JSON.parse(content) : content;
    
    const contentText = `
Title: ${parsedContent.title || 'Unknown'}
Content: ${parsedContent.content || parsedContent.bodyText || 'No content available'}
Meta Description: ${parsedContent.metaDescription || 'None'}
${parsedContent.headings?.length ? `\nHeadings:\n${parsedContent.headings.map(h => `- ${h.text || h}`).join('\n')}` : ''}
`.trim();

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': options.referer || 'https://github.com/monostate/node-scraper',
        'X-Title': 'BNCA Node Scraper',
      },
      body: JSON.stringify({
        model: options.model || 'meta-llama/llama-4-scout:free',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that answers questions based on website content. Provide accurate, concise answers based only on the provided content.'
          },
          {
            role: 'user',
            content: `Based on the following website content, please answer this question: ${question}\n\nWebsite content:\n${contentText}`
          }
        ],
        temperature: options.temperature || 0.3,
        max_tokens: options.maxTokens || 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'No response from AI';
  }

  /**
   * Process with OpenAI API
   * @private
   */
  async processWithOpenAI(question, content, apiKey, options = {}) {
    const parsedContent = typeof content === 'string' ? JSON.parse(content) : content;
    
    const contentText = `
Title: ${parsedContent.title || 'Unknown'}
Content: ${parsedContent.content || parsedContent.bodyText || 'No content available'}
Meta Description: ${parsedContent.metaDescription || 'None'}
${parsedContent.headings?.length ? `\nHeadings:\n${parsedContent.headings.map(h => `- ${h.text || h}`).join('\n')}` : ''}
`.trim();

    const baseUrl = options.openAIBaseUrl || 'https://api.openai.com';
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that answers questions based on website content. Provide accurate, concise answers based only on the provided content.'
          },
          {
            role: 'user',
            content: `Based on the following website content, please answer this question: ${question}\n\nWebsite content:\n${contentText}`
          }
        ],
        temperature: options.temperature || 0.3,
        max_tokens: options.maxTokens || 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'No response from AI';
  }

  /**
   * Local AI processing (simple pattern matching)
   * @private
   */
  processLocally(question, content) {
    const parsedContent = typeof content === 'string' ? 
      JSON.parse(content) : content;
      
    const title = parsedContent.title || 'Unknown';
    const text = parsedContent.content || parsedContent.bodyText || '';
    const lowerQuestion = question.toLowerCase();
    
    if (lowerQuestion.includes('title')) {
      return `The page title is "${title}".`;
    }
    
    if (lowerQuestion.includes('about') || lowerQuestion.includes('what')) {
      return `This page titled "${title}" contains: ${text.substring(0, 200)}...`;
    }
    
    if (lowerQuestion.includes('contact') || lowerQuestion.includes('email')) {
      const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
      return emailMatch ? 
        `Found contact: ${emailMatch[0]}` : 
        'No contact information found.';
    }
    
    return `Based on "${title}": ${text.substring(0, 150)}...`;
  }
  
  /**
   * Main scraping method with intelligent fallback.
   *
   * `success` means the transport worked AND the content is usable
   * (`contentStatus === 'usable'`). Every result carries httpStatus,
   * finalUrl, redirectChain, engine, contentStatus/contentReasons and a
   * redacted trace so callers can tell an empty shell or a block page from
   * real content.
   */
  async scrape(url, options = {}) {
    const startTime = Date.now();
    const config = { ...this.options, ...options };
    // One budget for the whole operation; every stage gets what is left of it.
    const deadline = Deadline.from({ totalMs: options.deadline ?? this.options.deadline, signal: options.signal ?? this.options.signal });
    config.deadline = deadline;
    config.signal = deadline.signal;
    const trace = new Trace({ operation: 'scrape', url });
    const fallbackChain = [];
    const requestedMethod = config.method;
    const isForced = Boolean(requestedMethod && requestedMethod !== 'auto');

    this.log(`🚀 Starting smart scrape for: ${url}`);

    const cancelledResult = () => {
      const aborted = deadline.reason() === 'aborted';
      return {
        success: false,
        transportSuccess: false,
        cancelled: true,
        error: aborted ? 'operation aborted' : `deadline of ${options.deadline ?? this.options.deadline}ms exceeded`,
        errorType: aborted ? 'cancelled' : 'timeout',
      };
    };

    const runStage = async (name, fn) => {
      const stage = trace.stage(name, { engine: name });
      if (deadline.expired()) {
        const result = cancelledResult();
        stage.end({ outcome: 'cancelled', reason: deadline.reason(), error: result.error });
        return result;
      }
      let result = await fn();
      if (!result.success && deadline.expired()) {
        result = { ...result, ...cancelledResult(), error: result.error || cancelledResult().error };
        stage.end({ outcome: 'cancelled', reason: deadline.reason(), httpStatus: result.httpStatus ?? null, error: result.error });
        return result;
      }
      stage.end({
        outcome: result.success ? 'ok' : 'error',
        reason: result.success ? (result.needsBrowser ? 'needs_browser' : result.contentStatus) : (result.errorType || 'error'),
        httpStatus: result.httpStatus ?? null,
        bytesIn: typeof result.size === 'number' ? result.size : (result.html ? result.html.length : null),
        error: result.success ? undefined : result.error,
      });
      return result;
    };

    const finish = async (result, method, { forced = false } = {}) => {
      const out = await this._finalize(url, result, method, config, { startTime, fallbackChain: forced ? null : fallbackChain, trace });
      deadline.dispose();
      this.emit('trace', out.trace);
      return out;
    };

    try {
      // PDF by URL (by extension or path)
      const lower = url.toLowerCase();
      if (lower.endsWith('.pdf') || lower.includes('.pdf?') || lower.includes('/pdf/')) {
        this.log('  📄 PDF detected, using PDF parser...');
        const pdf = await runStage('pdf', () => this.tryPDFParse(url, config));
        if (pdf.success) {
          this.log('  ✅ PDF parsing successful');
          return finish(pdf, 'pdf', { forced: true });
        }
        this.log('  ❌ PDF parsing failed');
      }

      if (isForced) {
        this.log(`  🎯 Method forced to: ${requestedMethod}`);
        const forcedEngines = {
          direct: ['direct-fetch', () => this.tryDirectFetch(url, config)],
          lightpanda: ['lightpanda', () => this.tryLightpanda(url, config)],
          puppeteer: ['puppeteer', () => this.tryPuppeteer(url, config)],
        };
        const entry = forcedEngines[requestedMethod];
        if (!entry) {
          trace.finish({ outcome: 'error' });
          return {
            success: false,
            error: `Invalid method: ${requestedMethod}. Valid methods are: auto, direct, lightpanda, puppeteer`,
            method: 'error',
            errorType: 'service_unavailable',
            performance: { totalTime: Date.now() - startTime },
          };
        }
        const [method, fn] = entry;
        const result = await runStage(method, fn);
        this.log(result.success ? `  ✅ ${requestedMethod} successful` : `  ❌ ${requestedMethod} failed`);
        return finish(result, method, { forced: true });
      }

      // ── auto: direct fetch → Lightpanda → Puppeteer ──
      this.log('  🔄 Attempting direct fetch...');
      fallbackChain.push('direct-fetch');
      let result = await runStage('direct-fetch', () => this.tryDirectFetch(url, config));
      let method = 'direct-fetch';

      if (result.isPdf) {
        this.log('  📄 Direct fetch detected PDF content, using PDF parser...');
        const pdf = await runStage('pdf', () => this.tryPDFParse(url, config));
        if (pdf.success) {
          this.log('  ✅ PDF parsing successful');
          return finish(pdf, 'pdf', { forced: true });
        }
        this.log('  ❌ PDF parsing failed');
        result = pdf;
        method = 'pdf';
      }

      if (this._isUsable(result) && !result.needsBrowser) {
        this.log('  ✅ Direct fetch successful');
        return finish(result, method);
      }

      // Not usable yet: a shell, a block page, an empty body or a transport
      // error. A real browser engine often gets through, so try them in order.
      this.log(result.needsBrowser ? '  ⚠️  Browser rendering required' : `  ❌ Direct fetch not usable (${result.contentStatus || result.errorType || 'error'})`);

      this.log('  🐼 Attempting Lightpanda...');
      fallbackChain.push('lightpanda');
      result = await runStage('lightpanda', () => this.tryLightpanda(url, config));
      method = 'lightpanda';
      if (this._isUsable(result)) {
        this.log('  ✅ Lightpanda successful');
        return finish(result, method);
      }

      this.log('  ❌ Lightpanda not usable, falling back to Puppeteer');
      this.log('  🔵 Attempting Puppeteer...');
      fallbackChain.push('puppeteer');
      result = await runStage('puppeteer', () => this.tryPuppeteer(url, config));
      method = 'puppeteer';
      if (this._isUsable(result)) {
        this.log('  ✅ Puppeteer successful');
        return finish(result, method);
      }

      this.log('  ❌ All methods exhausted');
      const transportOk = result.transportSuccess ?? Boolean(result.success);
      return finish(result, transportOk ? method : 'failed');
    } catch (error) {
      deadline.dispose();
      trace.finish({ outcome: 'error', error });
      const record = trace.toJSON();
      this.emit('trace', record);
      return {
        success: false,
        transportSuccess: false,
        method: 'error',
        engine: null,
        error: error.message,
        errorType: this.categorizeError(error.message),
        contentStatus: CONTENT_STATUS.NAVIGATION_ERROR,
        contentReasons: [`error:${String(error.message).slice(0, 80)}`],
        httpStatus: null,
        finalUrl: url,
        redirectChain: [],
        performance: { totalTime: Date.now() - startTime },
        trace: record,
      };
    }
  }

  /** Classification of a stage result; engines that return a document are judged on it. */
  _classify(result) {
    if (!result) return { status: CONTENT_STATUS.NAVIGATION_ERROR, reasons: ['error:no result'] };
    if (result.contentStatus) return { status: result.contentStatus, reasons: result.contentReasons || [] };
    if (typeof result.html === 'string' && result.html.length > 0) {
      return classifyContent({ httpStatus: result.httpStatus ?? null, html: result.html, error: result.success ? null : result.error });
    }
    if (result.success) return { status: CONTENT_STATUS.USABLE, reasons: [] };
    return { status: CONTENT_STATUS.NAVIGATION_ERROR, reasons: [`error:${String(result.error || 'unknown').slice(0, 80)}`] };
  }

  _isUsable(result) {
    const transportOk = result.transportSuccess ?? Boolean(result.success);
    return transportOk && this._classify(result).status === CONTENT_STATUS.USABLE;
  }

  /** Build the public result from a stage result. */
  async _finalize(url, result, method, config, { startTime, fallbackChain, trace }) {
    const cls = this._classify(result);
    const transportSuccess = result.transportSuccess ?? Boolean(result.success);
    let contentStatus = cls.status;
    let contentReasons = cls.reasons;
    const html = typeof result.html === 'string' ? result.html : '';
    const text = html ? stripHtmlToText(html) : '';

    if (transportSuccess && contentStatus === CONTENT_STATUS.USABLE && typeof config.acceptContent === 'function') {
      let verdict;
      try {
        verdict = await config.acceptContent({ status: contentStatus, reasons: contentReasons, text, html, httpStatus: result.httpStatus ?? null, finalUrl: result.finalUrl || url, content: result.content });
      } catch (err) {
        verdict = `acceptContent threw: ${err.message}`;
      }
      if (verdict !== true) {
        contentStatus = 'rejected_by_caller';
        contentReasons = [typeof verdict === 'string' && verdict ? verdict : 'acceptContent'];
      }
    }

    if (result.cancelled) {
      contentStatus = CONTENT_STATUS.NAVIGATION_ERROR;
      contentReasons = [result.errorType === 'cancelled' ? 'aborted' : 'deadline_exceeded'];
    }
    const success = transportSuccess && contentStatus === CONTENT_STATUS.USABLE;
    const error = result.error || (success ? undefined : `content_${contentStatus}`);
    const errorType = result.errorType ?? (success ? undefined : (contentStatus === CONTENT_STATUS.BLOCKED ? 'blocked' : this.categorizeError(error)));
    const traceOutcome = success ? 'ok' : (result.cancelled ? 'cancelled' : 'error');
    const traceRecord = trace.finish({ outcome: traceOutcome });

    const out = {
      ...result,
      success,
      transportSuccess,
      method,
      engine: method === 'failed' || method === 'error' ? null : method,
      httpStatus: result.httpStatus ?? null,
      finalUrl: result.finalUrl || url,
      redirectChain: Array.isArray(result.redirectChain) ? result.redirectChain : [],
      contentStatus,
      contentReasons,
      textLength: text.length,
      performance: { totalTime: Date.now() - startTime, method },
      stats: this.getStats(),
      trace: traceRecord,
    };
    if (error !== undefined) out.error = error; else delete out.error;
    if (errorType !== undefined) out.errorType = errorType; else delete out.errorType;
    if (fallbackChain) out.fallbackChain = fallbackChain;
    delete out.isPdf;
    return out;
  }

  /**
   * Direct HTTP fetch - fastest method for simple sites.
   * Follows redirects manually (max 10) so the chain is reported, keeps the
   * body of 4xx/5xx responses so block pages can be classified.
   */
  async tryDirectFetch(url, config) {
    this.stats.directFetch.attempts++;
    const headers = {
      'User-Agent': config.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
    };
    const redirectChain = [];
    const deadline = config.deadline instanceof Deadline ? config.deadline : null;
    const stageTimeout = deadline ? deadline.stageTimeout(config.timeout) : config.timeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('stage timeout')), stageTimeout);
    const signal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal;

    try {
      let current = url;
      let response = null;
      for (let hop = 0; hop <= 10; hop++) {
        response = await fetch(current, { headers, signal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) break;
          redirectChain.push({ url: current, status: response.status });
          await response.arrayBuffer().catch(() => {});
          if (hop === 10) throw new Error('too many redirects (>10)');
          current = new URL(location, current).toString();
          response = null;
          continue;
        }
        break;
      }
      if (!response) throw new Error('redirect without a final response');

      const httpStatus = response.status;
      const finalUrl = current;
      const base = { transportSuccess: true, httpStatus, finalUrl, redirectChain };

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/pdf')) {
        return { ...base, success: false, error: 'Content is PDF, should use PDF parser', isPdf: true };
      }

      const buffer = await response.arrayBuffer();
      const firstBytes = new Uint8Array(buffer.slice(0, 5));
      const signature = Array.from(firstBytes).map(b => String.fromCharCode(b)).join('');
      if (signature.startsWith('%PDF')) {
        return { ...base, success: false, error: 'Content is PDF (detected by magic bytes), should use PDF parser', isPdf: true };
      }

      const html = new TextDecoder().decode(buffer);
      const cls = classifyContent({ httpStatus, html });

      if (!response.ok) {
        return {
          ...base,
          success: false,
          html,
          size: html.length,
          contentType,
          contentStatus: cls.status,
          contentReasons: cls.reasons,
          error: `Direct fetch failed: HTTP ${httpStatus}: ${response.statusText}`,
          errorType: cls.status === CONTENT_STATUS.BLOCKED ? 'blocked' : (httpStatus === 404 ? 'service_unavailable' : 'network'),
        };
      }

      const needsBrowser = this.detectBrowserRequirement(html, finalUrl) || cls.status === CONTENT_STATUS.SHELL;
      if (needsBrowser) {
        return {
          ...base,
          success: true,
          needsBrowser: true,
          html,
          size: html.length,
          contentType,
          contentStatus: cls.status === CONTENT_STATUS.USABLE ? CONTENT_STATUS.SHELL : cls.status,
          contentReasons: cls.status === CONTENT_STATUS.USABLE ? ['needs_browser'] : cls.reasons,
          browserIndicators: this.getBrowserIndicators(html),
        };
      }

      const content = this.extractContentFromHTML(html);
      if (cls.status === CONTENT_STATUS.USABLE) this.stats.directFetch.successes++;
      return {
        ...base,
        success: true,
        needsBrowser: false,
        content,
        html,
        size: html.length,
        contentType: contentType || 'text/html',
        contentStatus: cls.status,
        contentReasons: cls.reasons,
      };
    } catch (error) {
      const errorMsg = error.message || 'Unknown error';
      let errorType = this.categorizeError(errorMsg);
      if (error.name === 'AbortError' || /abort/i.test(errorMsg)) {
        errorType = deadline?.reason() === 'aborted' ? 'cancelled' : 'timeout';
      }
      return {
        success: false,
        transportSuccess: false,
        httpStatus: null,
        finalUrl: url,
        redirectChain,
        error: `Direct fetch failed: ${errorType === 'cancelled' ? 'operation aborted' : errorType === 'timeout' ? `timed out after ${stageTimeout}ms` : errorMsg}`,
        errorType,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Lightpanda browser - fast browser engine for static/SSR sites.
   * Uses `fetch --json` so the HTTP status, final URL and navigation error
   * come back structured instead of being inferred from exit codes.
   */
  async tryLightpanda(url, config) {
    this.stats.lightpanda.attempts++;

    if (!this.options.lightpandaPath) {
      return {
        success: false,
        transportSuccess: false,
        error: 'Lightpanda scraping failed: Lightpanda binary not found. Please install Lightpanda or provide path.',
        errorType: 'service_unavailable',
      };
    }
    try {
      if (!statSync(this.options.lightpandaPath).isFile()) {
        return { success: false, transportSuccess: false, error: 'Lightpanda scraping failed: Lightpanda binary is not a file', errorType: 'service_unavailable' };
      }
    } catch {
      return { success: false, transportSuccess: false, error: 'Lightpanda scraping failed: Lightpanda binary not accessible', errorType: 'service_unavailable' };
    }

    const format = config.lightpandaFormat || 'html';
    const deadline = config.deadline instanceof Deadline ? config.deadline : null;
    const budget = deadline ? deadline.stageTimeout(Number(config.timeout) || 10000) : (Number(config.timeout) || 10000);
    const timeout = Math.max(250, Math.floor(budget));
    const waitMs = Math.min(config.lightpandaWaitMs ?? 5000, timeout);
    const args = [
      'fetch',
      '--json',
      '--dump', format,
      '--with-frames',
      '--http-timeout', String(timeout),
      '--wait-ms', String(waitMs),
      '--terminate-ms', String(timeout + 2000),
      url,
    ];

    return new Promise((resolve) => {
      const child = this._spawn(this.options.lightpandaPath, args, { timeout: timeout + 5000, signal: config.signal });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

      child.on('error', (error) => {
        resolve({ success: false, transportSuccess: false, error: `Lightpanda scraping failed: ${error.message}`, errorType: this.categorizeError(error.message) });
      });

      child.on('close', (code, signal) => {
        if (deadline?.expired() && !stdout.trim()) {
          const aborted = deadline.reason() === 'aborted';
          resolve({ success: false, transportSuccess: false, error: aborted ? 'Lightpanda aborted' : 'Lightpanda timed out at the deadline', errorType: aborted ? 'cancelled' : 'timeout', exitCode: code });
          return;
        }
        if (/has crashed|Fatal V8 Error|\$level=fatal/.test(stderr)) {
          resolve({ success: false, transportSuccess: false, error: `Lightpanda crashed: ${stderr.split('\n').find(l => l.includes('fatal') || l.includes('reason:')) || 'fatal error'}`, errorType: 'engine_crash', exitCode: code });
          return;
        }
        let payload = null;
        const jsonStart = stdout.indexOf('{');
        if (jsonStart !== -1) {
          try { payload = JSON.parse(stdout.slice(jsonStart)); } catch { payload = null; }
        }
        if (!payload) {
          const reason = signal ? `terminated by ${signal}` : `exited with code ${code}`;
          resolve({ success: false, transportSuccess: false, error: `Lightpanda scraping failed: ${stderr.trim() || reason}`, errorType: this.categorizeError(stderr || reason), exitCode: code });
          return;
        }
        if (payload.error) {
          resolve({ success: false, transportSuccess: false, httpStatus: payload.http_status ?? null, finalUrl: payload.url || url, redirectChain: [], error: `Lightpanda navigation failed: ${payload.error}`, errorType: this.categorizeError(payload.error), exitCode: code });
          return;
        }
        const html = typeof payload.content === 'string' ? payload.content : '';
        const httpStatus = payload.http_status ?? null;
        const finalUrl = payload.url || url;
        const cls = classifyContent({ httpStatus, html });
        const content = format === 'markdown'
          ? JSON.stringify({ title: html.match(/^#\s+(.+)$/m)?.[1] || '', content: html, extractedAt: new Date().toISOString() }, null, 2)
          : this.extractContentFromHTML(html);
        if (cls.status === CONTENT_STATUS.USABLE) this.stats.lightpanda.successes++;
        resolve({
          success: html.length > 0,
          transportSuccess: true,
          httpStatus,
          finalUrl,
          redirectChain: [],
          content,
          html,
          size: html.length,
          contentStatus: cls.status,
          contentReasons: cls.reasons,
          exitCode: code,
          ...(html.length === 0 && { error: 'Lightpanda returned an empty document', errorType: 'parsing' }),
        });
      });
    });
  }

  /** Test seam for child processes. */
  _spawn(cmd, args, opts) {
    return spawn(cmd, args, opts);
  }

  /**
   * Puppeteer browser - full Chromium for complex JavaScript sites
   */
  async tryPuppeteer(url, config) {
    this.stats.puppeteer.attempts++;
    
    if (!puppeteer) {
      return {
        success: false,
        transportSuccess: false,
        error: 'Puppeteer scraping failed: Puppeteer is not installed. Please install puppeteer package.',
        errorType: 'service_unavailable'
      };
    }
    
    let browser = null;
    let page = null;
    
    try {
      // Get browser from pool (bounded by the remaining budget)
      const deadline = config.deadline instanceof Deadline ? config.deadline : null;
      const navTimeout = deadline ? deadline.stageTimeout(config.timeout) : config.timeout;
      browser = await browserPool.getBrowser({ signal: config.signal, timeout: deadline ? deadline.stageTimeout(browserPool.acquireTimeout) : undefined });
      page = await browser.newPage();
      
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
      const response = await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: navTimeout,
      });
      const httpStatus = response ? response.status() : null;
      const redirectChain = response
        ? response.request().redirectChain().map(r => ({ url: r.url(), status: r.response()?.status() ?? null }))
        : [];
      const finalUrl = page.url();
      const html = await page.content();
      
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
      
      const cls = classifyContent({ httpStatus, html });
      if (cls.status === CONTENT_STATUS.USABLE) this.stats.puppeteer.successes++;
      
      return {
        success: true,
        transportSuccess: true,
        httpStatus,
        finalUrl,
        redirectChain,
        content: JSON.stringify(content, null, 2),
        html,
        size: html.length,
        contentStatus: cls.status,
        contentReasons: cls.reasons,
      };
      
    } catch (error) {
      const errorMsg = error.message || 'Unknown error';
      return {
        success: false,
        transportSuccess: false,
        httpStatus: null,
        finalUrl: url,
        redirectChain: [],
        error: `Puppeteer scraping failed: ${errorMsg}`,
        errorType: this.categorizeError(errorMsg)
      };
    } finally {
      // Always clean up page
      if (page) {
        try {
          // Check if page is still connected before closing
          if (!page.isClosed()) {
            await page.close();
          }
        } catch (e) {
          // Silently ignore protocol errors when page is already closed
          if (!e.message.includes('Protocol error') && !e.message.includes('Target closed')) {
            console.warn('Error closing page:', e.message);
          }
        }
      }
      
      // Release browser back to pool
      if (browser) {
        browserPool.releaseBrowser(browser);
      }
    }
  }
  
  /**
   * PDF parsing method - handles PDF documents
   */
  async tryPDFParse(url, config) {
    this.stats.pdf.attempts++;
    
    try {
      // Download PDF with timeout (bounded by the remaining budget)
      const deadline = config.deadline instanceof Deadline ? config.deadline : null;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), deadline ? deadline.stageTimeout(config.timeout) : config.timeout);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': config.userAgent,
          'Accept': 'application/pdf,*/*'
        },
        signal: config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }
      
      // Check content type (be lenient - accept various content types)
      const contentType = response.headers.get('content-type') || '';
      const acceptableTypes = ['pdf', 'octet-stream', 'binary', 'download'];
      const isAcceptableType = acceptableTypes.some(type => contentType.includes(type));
      
      if (!isAcceptableType && !url.toLowerCase().includes('.pdf')) {
        return {
          success: false,
          error: `Not a PDF document: ${contentType}`
        };
      }
      
      // Get PDF buffer
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Check size limit (20MB)
      if (buffer.length > 20 * 1024 * 1024) {
        return {
          success: false,
          error: 'PDF too large (max 20MB)'
        };
      }
      
      // Lazy-load pdf-parse (pdfjs-dist requires DOMMatrix, only available in Node 22+)
      if (!PDFParse) {
        const mod = await import('pdf-parse');
        PDFParse = mod.PDFParse;
      }
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      await parser.load();
      const textResult = await parser.getText();
      const infoResult = await parser.getInfo();
      parser.destroy();

      // Extract structured content
      const pdfInfo = infoResult.info || {};
      const content = {
        title: pdfInfo.Title || infoResult.outline?.[0]?.title || 'Untitled PDF',
        author: pdfInfo.Author || '',
        subject: pdfInfo.Subject || '',
        keywords: pdfInfo.Keywords || '',
        creator: pdfInfo.Creator || '',
        producer: pdfInfo.Producer || '',
        creationDate: pdfInfo.CreationDate || '',
        modificationDate: pdfInfo.ModDate || '',
        pages: textResult.total || 0,
        text: textResult.text || '',
        metadata: infoResult.metadata || null,
        url: url
      };

      this.stats.pdf.successes++;
      
      return {
        success: true,
        content: JSON.stringify(content, null, 2),
        size: buffer.length,
        contentType: 'application/pdf',
        pages: content.pages
      };
      
    } catch (error) {
      return {
        success: false,
        error: `PDF parsing error: ${error.message}`
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
      const windowDataMatch = html.match(/window\.__(INITIAL_STATE|INITIAL_DATA|NEXT_DATA)__\s*=\s*({[\s\S]*?});/);
      let windowData = null;
      if (windowDataMatch) {
        try {
          windowData = JSON.parse(windowDataMatch[2]);
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
    // Explicit override first, then the package's bin directory (postinstall)
    const packageBinPath = path.join(__dirname, 'bin', 'lightpanda');
    
    const possiblePaths = [
      ...(process.env.LIGHTPANDA_PATH ? [process.env.LIGHTPANDA_PATH] : []),
      packageBinPath, // Package's bin directory
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
          (this.stats.puppeteer.successes / this.stats.puppeteer.attempts * 100).toFixed(1) + '%' : '0%',
        pdf: this.stats.pdf.attempts > 0 ? 
          (this.stats.pdf.successes / this.stats.pdf.attempts * 100).toFixed(1) + '%' : '0%'
      }
    };
  }
  
  /**
   * Categorize error types for better error handling
   */
  categorizeError(errorMessage) {
    if (!errorMessage) return 'unknown';
    
    const error = errorMessage.toLowerCase();
    
    if (error.includes('crashed') || error.includes('fatal v8')) {
      return 'engine_crash';
    } else if (error.includes('cancelled') || error.includes('canceled') || error.includes('aborted')) {
      return 'cancelled';
    } else if (error.includes('access denied') || error.includes('blocked') || error.includes('http 403') || error.includes('http 429')) {
      return 'blocked';
    } else if (error.includes('timeout') || error.includes('timed out') || error.includes('abort')) {
      return 'timeout';
    } else if (error.includes('network') || error.includes('enotfound') || error.includes('econnrefused') || error.includes('econnreset')) {
      return 'network';
    } else if (error.includes('parse') || error.includes('parsing') || error.includes('invalid')) {
      return 'parsing';
    } else if (error.includes('not found') || error.includes('404') || error.includes('unavailable')) {
      return 'service_unavailable';
    }
    
    return 'unknown';
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
   * Find Chrome/Chromium binary path (shared discovery, honours BNCA_CHROME_PATH,
   * PUPPETEER_EXECUTABLE_PATH and CHROME_PATH).
   */
  async findChromePath() {
    return findChromePath();
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
  
  /**
   * Clean up resources - closes all browser instances
   */
  async cleanup() {
    await browserPool.closeAll();
  }
  
  /**
   * Bulk scrape multiple URLs with optimized concurrency
   * @param {string[]} urls - Array of URLs to scrape
   * @param {Object} options - Scraping options
   * @returns {Promise<Object>} Bulk scraping results
   */
  async bulkScrape(urls, options = {}) {
    const {
      concurrency = 5,
      progressCallback = null,
      continueOnError = true,
      ...scrapeOptions
    } = options;
    
    const results = {
      success: [],
      failed: [],
      total: urls.length,
      startTime: Date.now(),
      endTime: null,
      stats: {
        successful: 0,
        failed: 0,
        totalTime: 0,
        averageTime: 0,
        methods: {
          direct: 0,
          lightpanda: 0,
          puppeteer: 0,
          pdf: 0
        }
      }
    };
    
    // Process URLs in batches
    const batches = [];
    for (let i = 0; i < urls.length; i += concurrency) {
      batches.push(urls.slice(i, i + concurrency));
    }
    
    let processedCount = 0;
    
    for (const batch of batches) {
      const batchPromises = batch.map(async (url) => {
        const startTime = Date.now();
        try {
          const result = await this.scrape(url, scrapeOptions);
          const endTime = Date.now();
          const duration = endTime - startTime;
          
          const successResult = {
            url,
            ...result,
            duration,
            timestamp: new Date(endTime).toISOString()
          };
          
          results.success.push(successResult);
          results.stats.successful++;
          
          // Track method usage
          const key = result.method === 'direct-fetch' ? 'direct' : result.method;
          if (key && key in results.stats.methods) {
            results.stats.methods[key]++;
          }
          
          return successResult;
        } catch (error) {
          const endTime = Date.now();
          const duration = endTime - startTime;
          
          const failedResult = {
            url,
            success: false,
            error: error.message,
            duration,
            timestamp: new Date(endTime).toISOString()
          };
          
          results.failed.push(failedResult);
          results.stats.failed++;
          
          if (!continueOnError) {
            throw error;
          }
          
          return failedResult;
        } finally {
          processedCount++;
          if (progressCallback) {
            progressCallback({
              processed: processedCount,
              total: urls.length,
              percentage: (processedCount / urls.length) * 100,
              current: url
            });
          }
        }
      });
      
      await Promise.all(batchPromises);
    }
    
    results.endTime = Date.now();
    results.stats.totalTime = results.endTime - results.startTime;
    results.stats.averageTime = results.stats.totalTime / urls.length;
    
    return results;
  }
  
  /**
   * Bulk scrape with streaming results
   * @param {string[]} urls - Array of URLs to scrape
   * @param {Object} options - Scraping options with onResult callback
   * @returns {Promise<Object>} Summary statistics
   */
  async bulkScrapeStream(urls, options = {}) {
    const {
      concurrency = 5,
      onResult = null,
      onError = null,
      progressCallback = null,
      ...scrapeOptions
    } = options;
    
    if (!onResult) {
      throw new Error('onResult callback is required for streaming bulk scrape');
    }
    
    const stats = {
      total: urls.length,
      processed: 0,
      successful: 0,
      failed: 0,
      startTime: Date.now(),
      endTime: null,
      methods: {
        direct: 0,
        lightpanda: 0,
        puppeteer: 0,
        pdf: 0
      }
    };
    
    const queue = [...urls];
    const inProgress = new Set();
    
    const processNext = async () => {
      if (queue.length === 0 || inProgress.size >= concurrency) {
        return;
      }
      
      const url = queue.shift();
      inProgress.add(url);
      
      const startTime = Date.now();
      try {
        const result = await this.scrape(url, scrapeOptions);
        const duration = Date.now() - startTime;
        
        stats.successful++;
        if (result.method) {
          stats.methods[result.method]++;
        }
        
        await onResult({
          url,
          ...result,
          duration,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        stats.failed++;
        
        if (onError) {
          await onError({
            url,
            error: error.message,
            duration,
            timestamp: new Date().toISOString()
          });
        }
      } finally {
        inProgress.delete(url);
        stats.processed++;
        
        if (progressCallback) {
          progressCallback({
            processed: stats.processed,
            total: stats.total,
            percentage: (stats.processed / stats.total) * 100,
            current: url
          });
        }
        
        // Process next URL
        if (queue.length > 0) {
          processNext();
        }
      }
    };
    
    // Start initial batch
    const initialBatch = Math.min(concurrency, queue.length);
    const promises = [];
    for (let i = 0; i < initialBatch; i++) {
      promises.push(processNext());
    }
    
    // Wait for all to complete
    await Promise.all(promises);
    while (inProgress.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    stats.endTime = Date.now();
    stats.totalTime = stats.endTime - stats.startTime;
    stats.averageTime = stats.totalTime / stats.total;
    
    return stats;
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

export async function askWebsiteAI(url, question, options = {}) {
  const scraper = new BNCASmartScraper(options);
  try {
    const result = await scraper.askAI(url, question, options);
    return result;
  } catch (error) {
    throw error;
  } finally {
    await scraper.cleanup();
  }
}

export async function bulkScrape(urls, options = {}) {
  const scraper = new BNCASmartScraper(options);
  try {
    const result = await scraper.bulkScrape(urls, options);
    return result;
  } catch (error) {
    throw error;
  } finally {
    await scraper.cleanup();
  }
}

export async function bulkScrapeStream(urls, options = {}) {
  const scraper = new BNCASmartScraper(options);
  try {
    const result = await scraper.bulkScrapeStream(urls, options);
    return result;
  } catch (error) {
    throw error;
  } finally {
    await scraper.cleanup();
  }
}

// Browser session exports
export { BrowserSession, createSession } from './browser-session.js';
export { default as LightPandaServer, getLightPandaServer, stopLightPandaServer } from './lightpanda-server.js';
export { ComputerUseProvider } from './computer-use-provider.js';
export { LocalProvider } from './providers/local-provider.js';

export { CONTENT_STATUS, classifyContent };

export default BNCASmartScraper;