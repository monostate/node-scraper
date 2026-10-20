// Type definitions for @monostate/node-scraper v3
// Project: https://github.com/monostate/node-scraper
import { EventEmitter } from 'node:events';

// ── Content status ─────────────────────────────────────────────

export type ContentStatus =
  | 'usable'
  | 'browser_required_shell'
  | 'blocked'
  | 'empty'
  | 'navigation_error'
  | 'unsupported'
  | 'rejected_by_caller';

export const CONTENT_STATUS: {
  readonly USABLE: 'usable';
  readonly SHELL: 'browser_required_shell';
  readonly BLOCKED: 'blocked';
  readonly EMPTY: 'empty';
  readonly NAVIGATION_ERROR: 'navigation_error';
  readonly UNSUPPORTED: 'unsupported';
};
export const MIN_USABLE_TEXT_CHARS: number;
export const SHELL_TEXT_CHARS: number;
export function classifyContent(input: {
  httpStatus?: number | null;
  html?: string;
  text?: string;
  title?: string;
  error?: string | Error | null;
}): { status: ContentStatus; reasons: string[] };
export function stripHtmlToText(html: string): string;

// ── Telemetry ──────────────────────────────────────────────────

export type TraceOutcome = 'ok' | 'error' | 'cancelled' | 'fallback';
export interface TokenUsage {
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface StageRecord {
  name: string;
  engine: string | null;
  startedAt: string;
  durationMs: number | null;
  outcome: string | null;
  reason: string | null;
  bytesIn: number | null;
  bytesOut: number | null;
  httpStatus: number | null;
  attempts: number | null;
  queueMs: number | null;
  error: string | null;
}
export interface TraceEvent { type: string; at: number; [key: string]: unknown }
export interface TraceRecord {
  id: string;
  operation: string;
  url: string | null;
  startedAt: string;
  durationMs: number;
  outcome: TraceOutcome;
  stages: StageRecord[];
  events: TraceEvent[];
  usage?: TokenUsage;
  error?: string;
}
export interface TraceStage {
  end(opts?: {
    outcome?: 'ok' | 'error' | 'skipped' | 'fallback' | 'cancelled';
    reason?: string;
    bytesIn?: number;
    bytesOut?: number;
    httpStatus?: number | null;
    attempts?: number;
    queueMs?: number;
    error?: Error | string;
  }): StageRecord;
}
export declare class Trace {
  constructor(opts: { operation: string; url?: string; redact?: boolean });
  readonly id: string;
  readonly operation: string;
  stage(name: string, opts?: { engine?: string | null }): TraceStage;
  event(type: string, data?: Record<string, unknown>): void;
  setUsage(usage: Partial<TokenUsage>): void;
  finish(opts?: { outcome?: TraceOutcome; error?: Error | string }): TraceRecord;
  toJSON(): TraceRecord;
}

// ── Deadline ───────────────────────────────────────────────────

export declare class DeadlineError extends Error {
  code: 'DEADLINE_EXCEEDED' | 'ABORTED';
}
export declare class Deadline {
  constructor(opts?: { totalMs?: number; signal?: AbortSignal });
  static from(input?: Deadline | number | { totalMs?: number; signal?: AbortSignal }): Deadline;
  readonly signal: AbortSignal;
  remaining(): number;
  expired(): boolean;
  reason(): 'timeout' | 'aborted' | null;
  stageTimeout(maxMs: number): number;
  throwIfExpired(): void;
  child(maxMs: number): Deadline;
  dispose(): void;
}

// ── Scraper ────────────────────────────────────────────────────

export type ScrapeMethod = 'auto' | 'direct' | 'lightpanda' | 'puppeteer';
export type Engine = 'direct-fetch' | 'lightpanda' | 'puppeteer' | 'pdf';
export type ErrorType = 'network' | 'timeout' | 'parsing' | 'service_unavailable' | 'blocked' | 'engine_crash' | 'cancelled' | 'unknown';

export interface AcceptContentContext {
  status: ContentStatus;
  reasons: string[];
  text: string;
  html: string;
  httpStatus: number | null;
  finalUrl: string;
  content?: string;
}

export interface ScrapingOptions {
  /** "auto" (default), "direct", "lightpanda" or "puppeteer" */
  method?: ScrapeMethod;
  /** Per-stage timeout in ms (default 10000) */
  timeout?: number;
  /** Total budget in ms for the whole operation across every stage */
  deadline?: number;
  /** Abort the operation (releases browsers, sockets, child processes) */
  signal?: AbortSignal;
  retries?: number;
  verbose?: boolean;
  lightpandaPath?: string;
  lightpandaFormat?: 'html' | 'markdown';
  lightpandaWaitMs?: number;
  userAgent?: string;
  /** Launch pooled Chrome without its sandbox (containers). Default keeps the sandbox on. */
  noSandbox?: boolean;
  /** Disable Chrome's same-origin policy (off by default). */
  disableWebSecurity?: boolean;
  /** Caller validation: return true to accept, false or a reason string to reject (contentStatus 'rejected_by_caller'). */
  acceptContent?: (ctx: AcceptContentContext) => boolean | string | Promise<boolean | string>;
  openRouterApiKey?: string;
  openRouterBaseUrl?: string;
  openAIApiKey?: string;
  openAIBaseUrl?: string;
  /** Your own answer endpoint: receives POST { url, question } with header x-api-key: aiApiKey */
  aiEndpoint?: string;
  aiApiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  referer?: string;
  /** @deprecated Ignored in v3; the hosted endpoint was removed. Use aiEndpoint/aiApiKey. */
  apiKey?: string;
  /** @deprecated Ignored in v3. */
  apiUrl?: string;
}

export interface RedirectHop { url: string; status: number | null }

export interface ScrapingResult {
  /** transportSuccess && contentStatus === 'usable' */
  success: boolean;
  /** The engine completed its request/response cycle */
  transportSuccess: boolean;
  method: Engine | 'direct-fetch' | 'chrome-screenshot' | 'quickshot' | 'failed' | 'error';
  engine: Engine | null;
  httpStatus: number | null;
  finalUrl: string;
  redirectChain: RedirectHop[];
  contentStatus: ContentStatus;
  contentReasons: string[];
  textLength: number;
  content?: string;
  html?: string;
  size?: number;
  needsBrowser?: boolean;
  contentType?: string;
  browserIndicators?: string[];
  error?: string;
  errorType?: ErrorType;
  details?: string;
  cancelled?: boolean;
  exitCode?: number | null;
  screenshot?: string;
  performance: { totalTime: number; method?: string; systemMetrics?: SystemMetrics };
  stats?: ScrapingStats;
  /** Engines attempted (auto mode only) */
  fallbackChain?: string[];
  trace: TraceRecord;
}

export interface StageResult {
  success: boolean;
  transportSuccess?: boolean;
  httpStatus?: number | null;
  finalUrl?: string;
  redirectChain?: RedirectHop[];
  html?: string;
  content?: string;
  size?: number;
  needsBrowser?: boolean;
  contentStatus?: ContentStatus;
  contentReasons?: string[];
  isPdf?: boolean;
  error?: string;
  errorType?: ErrorType;
  [key: string]: unknown;
}

export interface SystemMetrics {
  duration?: number;
  samples?: number;
  memory?: { heapUsed: MetricStats; rss: MetricStats };
  cpu?: MetricStats;
  systemMemory?: MetricStats;
  error?: string;
}
export interface MetricStats { min: number; max: number; avg: number; peak?: number }
export interface MethodStats { attempts: number; successes: number }
export interface ScrapingStats {
  directFetch: MethodStats;
  lightpanda: MethodStats;
  puppeteer: MethodStats;
  pdf: MethodStats;
  successRates: { directFetch: string; lightpanda: string; puppeteer: string; pdf: string };
}
export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy';
  methods: { directFetch: boolean; lightpanda: boolean; puppeteer: boolean };
  timestamp: string;
}

export interface AskAIResult {
  success: boolean;
  answer?: string;
  error?: string;
  method?: string;
  contentStatus?: ContentStatus;
  scrapeTime?: number;
  processing?: 'openrouter' | 'openai' | 'endpoint' | 'local';
  usage?: TokenUsage;
  trace?: TraceRecord;
}

export interface BulkScrapeOptions extends ScrapingOptions {
  concurrency?: number;
  progressCallback?: (progress: BulkProgress) => void;
  continueOnError?: boolean;
}
export interface BulkScrapeStreamOptions extends ScrapingOptions {
  concurrency?: number;
  onResult: (result: BulkScrapeResultItem) => void | Promise<void>;
  onError?: (error: BulkScrapeErrorItem) => void | Promise<void>;
  progressCallback?: (progress: BulkProgress) => void;
}
export interface BulkProgress { processed: number; total: number; percentage: number; current: string }
export interface BulkScrapeResult {
  success: BulkScrapeResultItem[];
  failed: BulkScrapeErrorItem[];
  total: number;
  startTime: number;
  endTime: number;
  stats: BulkScrapeStats;
}
export interface BulkScrapeResultItem extends ScrapingResult { url: string; duration: number; timestamp: string }
export interface BulkScrapeErrorItem { url: string; success: false; error: string; duration: number; timestamp: string }
export interface BulkScrapeStats {
  successful: number;
  failed: number;
  totalTime: number;
  averageTime: number;
  methods: { direct: number; lightpanda: number; puppeteer: number; pdf: number };
}
export interface BulkScrapeStreamStats extends BulkScrapeStats { total: number; processed: number; startTime: number; endTime: number }

export declare class BNCASmartScraper extends EventEmitter {
  constructor(options?: ScrapingOptions);
  options: ScrapingOptions & Record<string, unknown>;
  scrape(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
  screenshot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
  quickshot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
  askAI(url: string, question: string, options?: ScrapingOptions): Promise<AskAIResult>;
  getStats(): ScrapingStats;
  healthCheck(): Promise<HealthCheckResult>;
  /** Drain the shared browser pool; the scraper stays usable. */
  cleanup(): Promise<void>;
  bulkScrape(urls: string[], options?: BulkScrapeOptions): Promise<BulkScrapeResult>;
  bulkScrapeStream(urls: string[], options: BulkScrapeStreamOptions): Promise<BulkScrapeStreamStats>;
  findChromePath(): Promise<string | null>;
  findLightpandaBinary(): string | null;
  /** Engine stages (also the seams tests stub). */
  tryDirectFetch(url: string, config: ScrapingOptions): Promise<StageResult>;
  tryLightpanda(url: string, config: ScrapingOptions): Promise<StageResult>;
  tryPuppeteer(url: string, config: ScrapingOptions): Promise<StageResult>;
  tryPDFParse(url: string, config: ScrapingOptions): Promise<StageResult>;
  detectBrowserRequirement(html: string, url: string): boolean;
  extractContentFromHTML(html: string): string;
  categorizeError(message: string): ErrorType;
  on(event: 'trace', listener: (trace: TraceRecord) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export function smartScrape(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
export function smartScreenshot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
export function quickShot(url: string, options?: ScrapingOptions): Promise<ScrapingResult>;
export function askWebsiteAI(url: string, question: string, options?: ScrapingOptions): Promise<AskAIResult>;
export function bulkScrape(urls: string[], options?: BulkScrapeOptions): Promise<BulkScrapeResult>;
export function bulkScrapeStream(urls: string[], options: BulkScrapeStreamOptions): Promise<BulkScrapeStreamStats>;
export function getBrowserPoolStats(): PoolStats;

// ── Browser pool ───────────────────────────────────────────────

export interface PoolLaunchOptions {
  headless?: boolean;
  noSandbox?: boolean;
  disableWebSecurity?: boolean;
  executablePath?: string;
  extraArgs?: string[];
}
export interface PoolOptions {
  maxInstances?: number;
  idleTimeout?: number;
  maxQueue?: number;
  acquireTimeout?: number;
  launch?: PoolLaunchOptions;
}
export interface PoolStats {
  created: number;
  reused: number;
  queued: number;
  cleaned: number;
  failed: number;
  poolSize: number;
  busyCount: number;
  idleCount: number;
  queueLength: number;
  pending: number;
  maxInstances: number;
}
export declare class PoolClosedError extends Error { code: 'POOL_CLOSED' }
export declare class PoolQueueFullError extends Error { code: 'POOL_QUEUE_FULL' }
export declare class PoolAcquireTimeoutError extends Error { code: 'POOL_ACQUIRE_TIMEOUT' }
export declare class PoolAbortedError extends Error { code: 'POOL_ABORTED' }
export function buildLaunchArgs(opts?: { noSandbox?: boolean; disableWebSecurity?: boolean; extraArgs?: string[] }): string[];
export declare class BrowserPool extends EventEmitter {
  constructor(maxOrOpts?: number | PoolOptions, idleTimeout?: number);
  maxInstances: number;
  idleTimeout: number;
  maxQueue: number;
  acquireTimeout: number;
  launch: PoolLaunchOptions;
  configure(partial: PoolOptions): this;
  getBrowser(opts?: { timeout?: number; signal?: AbortSignal }): Promise<any>;
  releaseBrowser(browser: any): void;
  /** Reject waiters and close browsers; the pool stays usable. */
  closeAll(): Promise<void>;
  /** closeAll() plus refuse later acquisitions until reopen(). */
  shutdown(): Promise<void>;
  reopen(): this;
  getStats(): PoolStats;
}

// ── Capabilities ───────────────────────────────────────────────

export interface CapabilityEntry { available: boolean; version?: string | null; path?: string | null }
export interface CapabilityReport {
  platform: string;
  arch: string;
  node: string;
  puppeteer: CapabilityEntry;
  ws: CapabilityEntry;
  chrome: CapabilityEntry;
  lightpanda: CapabilityEntry;
  xvfb: CapabilityEntry;
  xdotool: CapabilityEntry;
  x11vnc: CapabilityEntry;
  imagemagick: CapabilityEntry;
  modes: { http: true; lightpanda: boolean; chrome: boolean; visual: boolean; computerUse: boolean; vnc: boolean };
  missing: Array<{ capability: string; install: string }>;
}
export declare class CapabilityError extends Error {
  constructor(capability: string, install?: string | null);
  code: 'CAPABILITY_MISSING';
  capability: string;
  install: string | null;
}
export const INSTALL_HINTS: Readonly<Record<string, string>>;
export function checkCapabilities(opts?: { lightpandaPath?: string; chromePath?: string; platform?: string }): Promise<CapabilityReport>;
export function requireCapability(report: CapabilityReport, name: string): void;

// ── Chrome discovery, redaction, keys, install, process helpers ───

export const CHROME_CANDIDATES: Readonly<Record<string, readonly string[]>>;
export function findChromePath(opts?: { env?: Record<string, string | undefined>; candidates?: Record<string, string[]>; platform?: string }): Promise<string | null>;

export const SENSITIVE_FIELD_RE: RegExp;
export function isSensitiveField(field: { type?: string; name?: string; id?: string; autocomplete?: string; label?: string; placeholder?: string }): boolean;
export function redactUrl(url: string): string;
export function redactText(text: string): string;
export function redactValue(value: string, field: Parameters<typeof isSensitiveField>[0]): string;
export function redactErrorMessage(message: string | Error | null | undefined): string;

export function normalizeXdoKey(key: string): string;

export const DEFAULT_REF_ATTR: string;
export function collectPageState(opts: { maxText?: number; maxElements?: number; offset?: number; includeValues?: boolean; sensitiveRe?: string; refAttr?: string }): unknown;

export const LIGHTPANDA_VERSION: string;
export const LIGHTPANDA_CHECKSUMS: Readonly<Record<string, string>>;
export interface InstallResult {
  status: 'installed' | 'present' | 'skipped' | 'unsupported' | 'failed';
  path?: string;
  version?: string;
  reason?: string;
}
export function installLightpanda(opts?: {
  binDir?: string;
  version?: string;
  force?: boolean;
  skip?: boolean;
  platform?: string;
  arch?: string;
  log?: (line: string) => void;
}): Promise<InstallResult>;
export function assetNameFor(opts?: { platform?: string; arch?: string }): string | null;

export function terminate(proc: any, opts?: { graceMs?: number }): Promise<{ code: number | null; signal: string | null; forced: boolean }>;
export function waitForHttpOk(url: string, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<Response>;
export function waitForTcp(host: string, port: number, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
export function waitForPath(path: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
export function findFreePort(): Promise<number>;
export function makeTempDir(prefix?: string): Promise<string>;
export function removeDir(path: string): Promise<void>;
export function minimalEnv(extra?: Record<string, string>, opts?: { inherit?: string[] }): Record<string, string>;
export function allocateDisplay(opts?: { from?: number; to?: number; lockDir?: string }): Promise<{ display: string; displayNum: number; lockPath: string; release(): Promise<void> }>;

// ── Computer-use providers ─────────────────────────────────────

export type MouseButton = 'left' | 'right' | 'middle';
export type CoordinateSpace = 'desktop' | 'page';

export interface ProviderVncInfo { host: string; port: number; auth: 'none' | 'password'; loopbackOnly: boolean }
export interface ProviderInfo {
  cdpUrl: string;
  vncUrl: string | null;
  vnc?: ProviderVncInfo | null;
  screenSize: { width: number; height: number };
  display?: string;
  profileDir?: string;
}
export interface ProviderScreenshot {
  screenshot: string;
  coordinateSpace: CoordinateSpace;
  width: number;
  height: number;
  dpr: number;
}
export interface ProviderCapabilities { desktopScreenshot: boolean; pageScreenshot: boolean; vnc: boolean; nativeInput: boolean }
export interface CoordinateActionResult { success: boolean; screenshot?: string | null; error?: string | null }
export interface DragOptionsBase { steps?: number; stepDelayMs?: number; holdMs?: number; button?: MouseButton }

export declare class ComputerUseProvider {
  start(): Promise<ProviderInfo>;
  stop(): Promise<void>;
  screenshot(opts?: { space?: CoordinateSpace }): Promise<ProviderScreenshot>;
  getCapabilities(): Promise<ProviderCapabilities>;
  mouseMove(x: number, y: number): Promise<CoordinateActionResult>;
  mouseDown(x: number, y: number, button?: MouseButton): Promise<CoordinateActionResult>;
  mouseUp(button?: MouseButton): Promise<CoordinateActionResult>;
  mouseClick(x: number, y: number, button?: MouseButton): Promise<CoordinateActionResult>;
  mouseDoubleClick(x: number, y: number, button?: MouseButton): Promise<CoordinateActionResult>;
  mouseDrag(startX: number, startY: number, endX: number, endY: number, opts?: DragOptionsBase): Promise<CoordinateActionResult>;
  scroll(x: number, y: number, direction: 'up' | 'down', amount?: number): Promise<CoordinateActionResult>;
  /** Desktop (native) key press; W3C names accepted */
  pressKey(key: string): Promise<CoordinateActionResult>;
  /** Desktop (native) typing */
  typeText(text: string): Promise<CoordinateActionResult>;
  wait(ms: number): Promise<CoordinateActionResult>;
  getCursorPosition(): Promise<{ x: number; y: number }>;
  getScreenSize(): Promise<{ width: number; height: number }>;
}

export interface LocalProviderOptions {
  screenWidth?: number;
  screenHeight?: number;
  enableVnc?: boolean;
  /** Loopback-only by default; a non-loopback bind requires a password */
  vnc?: { bind?: string; password?: string | null; shared?: boolean };
  chromePath?: string;
  chromeArgs?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  noSandbox?: boolean;
  startTimeoutMs?: number;
  profileDir?: string | null;
}
export declare class LocalProvider extends ComputerUseProvider {
  constructor(options?: LocalProviderOptions);
  stop(opts?: { graceMs?: number }): Promise<void>;
}

// ── Browser session ────────────────────────────────────────────

export type SessionMode = 'headless' | 'chrome' | 'visual' | 'auto' | 'computer-use';
export type Backend = 'lightpanda' | 'chrome' | 'computer-use';
export type ActionOutcome = 'ok' | 'uncertain';
export type ActionKind = 'safe' | 'mutating';
export const ACTION_KIND: { readonly SAFE: 'safe'; readonly MUTATING: 'mutating' };
export const ACTION_KINDS: Readonly<Record<string, ActionKind>>;

export interface DialogInfo { type: string; message: string; defaultValue: string }
export interface DialogDecision { action: 'accept' | 'dismiss'; promptText?: string }
export type DialogHandler = DialogDecision | ((dialog: DialogInfo) => DialogDecision | Promise<DialogDecision>);
export interface DialogRecord extends DialogInfo { action: 'accept' | 'dismiss'; promptText: string | null; at: number }

export interface BrowserSessionOptions {
  mode?: SessionMode;
  timeout?: number;
  userAgent?: string;
  lightpandaPath?: string;
  verbose?: boolean;
  provider?: ComputerUseProvider;
  /** Fresh browser context per pooled session (default true) */
  isolate?: boolean;
  /** Alias for isolate:false */
  persistent?: boolean;
  recordTypedText?: boolean;
  redact?: boolean;
  noSandbox?: boolean;
  disableWebSecurity?: boolean;
  acquireTimeout?: number;
  signal?: AbortSignal;
  /** Total budget in ms for connect + every action */
  deadline?: number;
  maxStateText?: number;
  maxStateElements?: number;
  dialogHandler?: DialogHandler;
  maxUploadBytes?: number;
}

export interface ActionResult {
  success: boolean;
  outcome?: ActionOutcome;
  uncertainReason?: string;
  error?: string;
  url?: string;
  httpStatus?: number | null;
  backend?: string;
  screenshot?: string;
}

export interface PageStateElement {
  ref: string;
  /** `[data-bnca-ref="eN"]`, prefixed with `pierce/` inside shadow roots */
  selector: string;
  id: string | null;
  role: string;
  tag: string;
  type: string | null;
  text: string;
  label: string;
  name: string | null;
  placeholder: string | null;
  href: string | null;
  required: boolean;
  disabled: boolean;
  invalid: boolean;
  validationMessage: string;
  bounds: { x: number; y: number; width: number; height: number };
  inShadow: boolean;
  checked?: boolean;
  /** '[redacted]' for password/OTP/sensitive fields */
  value?: string;
}
export interface PageStateForm { ref: string; selector: string; id: string | null; action: string | null; method: string; invalid: string[] }
export interface FrameInfo { id: string; name: string | null; url: string; parentId?: string | null; isMain: boolean }
export interface PageInfo { index: number; url: string; title: string; active: boolean }
export interface PageState {
  url: string;
  title: string;
  text: string;
  elements: PageStateElement[];
  /** Same array as `elements` (2.x compatibility) */
  interactiveElements: PageStateElement[];
  forms: PageStateForm[];
  truncated: { text: boolean; elements: boolean; total: number };
  coordinateSpace: 'page';
  frame: FrameInfo | null;
  screenshot?: string;
  screenshotError?: string;
  backend: Backend | null;
  sessionHistory: Array<Record<string, unknown>>;
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: unknown;
}
export interface Checkpoint {
  url: string;
  cookies: Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  formValues: Array<{ selector: string; tag: string; type: string; value?: string; checked?: boolean }>;
  captured: string[];
  notTransferable: string[];
}
export interface RestoreResult { restored: string[]; skipped: Array<{ item: string; reason: string }> }

export type UploadFile = string | { name: string; data: Buffer | Uint8Array; mimeType?: string };
export interface UploadResult {
  success: boolean;
  outcome: ActionOutcome;
  uncertainReason?: string;
  error?: string;
  files: Array<{ name: string; size: number; mimeType: string | null }>;
  attached?: string[];
}
export interface FileChooserHandle { isMultiple: boolean; accept(files: UploadFile[]): Promise<void>; cancel(): Promise<void> }
export interface DownloadRecord {
  id: string;
  url: string;
  suggestedFilename: string;
  path: string | null;
  state: 'inProgress' | 'completed' | 'canceled';
  receivedBytes: number;
  totalBytes: number | null;
  startedAt: number;
  error?: string;
}

export interface SessionGeometry {
  screen: { width: number | null; height: number | null };
  viewport: { width: number; height: number };
  dpr: number;
  offset: { x: number; y: number };
  method: 'calibrated' | 'window-bounds' | 'assumed-zero';
}
export interface SessionScreenshot {
  success: boolean;
  screenshot: string;
  backend: Backend | null;
  coordinateSpace: CoordinateSpace;
  width: number | null;
  height: number | null;
  dpr: number;
  offset: { x: number; y: number };
}
export interface CoordinateOptions { space?: CoordinateSpace; button?: MouseButton }
export interface DragOptions extends CoordinateOptions, DragOptionsBase {}

export interface BrowserAction {
  type: 'goto' | 'click' | 'type' | 'scroll' | 'hover' | 'select' | 'pressKey' | 'goBack' | 'goForward' | 'screenshot' | 'extractContent' | 'waitFor'
    | 'uploadFile' | 'mouseMove' | 'clickAt' | 'doubleClickAt' | 'drag' | 'scrollAt' | 'typeText' | 'desktopKey' | 'desktopType' | 'calibrate' | 'getGeometry' | 'getCursorPosition' | 'getScreenSize';
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  values?: string[];
  timeout?: number;
  expectNavigation?: boolean;
  waitForNavigation?: boolean;
  clear?: boolean;
  delay?: number;
  fullPage?: boolean;
  type_?: 'png' | 'jpeg' | 'webp';
  space?: CoordinateSpace;
  includeScreenshot?: boolean;
  files?: UploadFile[];
  x?: number;
  y?: number;
  button?: MouseButton;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  steps?: number;
  stepDelayMs?: number;
}

export declare class BrowserSession extends EventEmitter {
  constructor(options?: BrowserSessionOptions);

  readonly mode: SessionMode;
  readonly activeBackend: Backend | null;
  readonly deadline: Deadline;
  /** Underlying Puppeteer objects (engine-specific; prefer the public API) */
  readonly browser: any;
  readonly page: any;
  readonly context: any;

  connect(): Promise<BrowserSession>;
  close(): Promise<void>;

  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<ActionResult>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  click(selector: string, options?: { timeout?: number; expectNavigation?: boolean; waitForNavigation?: boolean; navigationTimeout?: number }): Promise<ActionResult>;
  type(selector: string, text: string, options?: { timeout?: number; clear?: boolean; delay?: number }): Promise<ActionResult>;
  scroll(direction?: 'up' | 'down', amount?: number): Promise<ActionResult>;
  hover(selector: string): Promise<ActionResult>;
  select(selector: string, ...values: string[]): Promise<ActionResult>;
  /** Page (CDP) key press — works in every mode */
  pressKey(key: string): Promise<ActionResult>;
  waitFor(selector: string, timeout?: number): Promise<ActionResult>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  extractContent(): Promise<{ title: string; metaDescription: string; headings: Array<{ level: string; text: string }>; paragraphs: string[]; links: Array<{ text: string; href: string }>; bodyText: string; url: string }>;
  screenshot(options?: { space?: CoordinateSpace; fullPage?: boolean; type_?: 'png' | 'jpeg' | 'webp' }): Promise<SessionScreenshot>;

  getPageState(options?: { includeScreenshot?: boolean; maxText?: number; maxElements?: number; offset?: number; includeValues?: boolean; fullPage?: boolean }): Promise<PageState>;
  executeAction(action: BrowserAction): Promise<any>;

  setDialogHandler(handler: DialogHandler | null): this;
  getDialogs(): DialogRecord[];

  frames(): Promise<FrameInfo[]>;
  useFrame(target: string | ((frame: FrameInfo) => boolean)): Promise<FrameInfo>;
  useMainFrame(): this;
  pages(): Promise<PageInfo[]>;
  usePage(index: number): Promise<{ index: number; url: string }>;
  waitForNewPage(opts?: { timeout?: number }): Promise<{ index: number; url: string }>;

  uploadFile(selector: string, files: UploadFile | UploadFile[], opts?: { timeout?: number }): Promise<UploadResult>;
  waitForFileChooser(opts?: { timeout?: number }): Promise<FileChooserHandle>;
  enableDownloads(opts: { dir: string; maxBytes?: number }): Promise<{ dir: string }>;
  downloads(): DownloadRecord[];
  waitForDownload(opts?: { timeout?: number }): Promise<DownloadRecord>;

  getCookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  checkpoint(): Promise<Checkpoint>;
  restore(checkpoint: Checkpoint): Promise<RestoreResult>;

  /** Coordinate actions (computer-use mode). `space` defaults to 'desktop'. */
  getGeometry(): Promise<SessionGeometry>;
  calibrate(opts?: { timeout?: number }): Promise<SessionGeometry>;
  toDesktop(x: number, y: number): Promise<{ x: number; y: number }>;
  toPage(x: number, y: number): Promise<{ x: number; y: number }>;
  mouseMove(x: number, y: number, opts?: CoordinateOptions): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  clickAt(x: number, y: number, buttonOrOpts?: MouseButton | CoordinateOptions, opts?: CoordinateOptions): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  doubleClickAt(x: number, y: number, buttonOrOpts?: MouseButton | CoordinateOptions, opts?: CoordinateOptions): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  drag(startX: number, startY: number, endX: number, endY: number, opts?: DragOptions): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  scrollAt(x: number, y: number, direction?: 'up' | 'down', amount?: number, opts?: CoordinateOptions): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  /** Page typing into the focused editable element; 'uncertain' when nothing editable is focused */
  typeText(text: string): Promise<ActionResult>;
  /** Native desktop key press through the provider (W3C names accepted) */
  desktopKey(key: string): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  /** Native desktop typing through the provider */
  desktopType(text: string): Promise<CoordinateActionResult & { outcome: 'ok' }>;
  getCursorPosition(): Promise<{ x: number; y: number }>;
  getScreenSize(): Promise<{ width: number; height: number }>;
  getVncUrl(): string | null;
  getProviderInfo(): ProviderInfo | null;

  getHistory(): Array<Record<string, unknown>>;
  getBackend(): Backend | null;

  on(event: 'newPage', listener: (info: { index: number; url: string }) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export function createSession(options?: BrowserSessionOptions): Promise<BrowserSession>;

// ── LightPanda server ──────────────────────────────────────────

export declare class LightPandaServer {
  constructor(binaryPath?: string, opts?: { startTimeoutMs?: number; maxConnections?: number; host?: string });
  readonly binaryPath: string;
  start(opts?: { signal?: AbortSignal }): Promise<string>;
  stop(opts?: { graceMs?: number }): Promise<void>;
  version(): Promise<string | null>;
  getEndpoint(): string;
  isRunning(): boolean;
}
export function getLightPandaServer(binaryPath?: string, opts?: { startTimeoutMs?: number; maxConnections?: number }): LightPandaServer;
export function stopLightPandaServer(): Promise<void>;

export default BNCASmartScraper;
