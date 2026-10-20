// Type-level consumer of the public API. Compiled with tsc --noEmit --strict
// by test/types.test.mjs. Uses only public exports; never session.page.
import {
  BNCASmartScraper, smartScrape, createSession, BrowserSession, LocalProvider, ComputerUseProvider,
  BrowserPool, buildLaunchArgs, PoolAcquireTimeoutError, Deadline, DeadlineError, CONTENT_STATUS, classifyContent,
  checkCapabilities, CapabilityError, Trace, redactUrl, isSensitiveField, normalizeXdoKey, LIGHTPANDA_VERSION,
  installLightpanda, getBrowserPoolStats, ACTION_KIND, MIN_USABLE_TEXT_CHARS, SHELL_TEXT_CHARS,
  type ScrapingResult, type ScrapingOptions, type PageState, type ActionResult, type ProviderInfo, type ProviderScreenshot,
  type Checkpoint, type RestoreResult, type TraceRecord, type CapabilityReport, type SessionGeometry, type DownloadRecord,
  type BrowserSessionOptions, type ContentStatus,
} from '../../index.js';

async function httpAndEngines(): Promise<void> {
  const scraper = new BNCASmartScraper({ timeout: 5000, deadline: 20000, noSandbox: false });
  scraper.on('trace', (t: TraceRecord) => { const n: number = t.durationMs; void n; });
  const r: ScrapingResult = await scraper.scrape('https://example.com', {
    method: 'auto',
    acceptContent: ({ text, httpStatus }) => text.length > 10 && httpStatus === 200,
  });
  const status: ContentStatus = r.contentStatus;
  if (status === CONTENT_STATUS.BLOCKED) console.log(r.contentReasons.join(','));
  const chain: Array<{ url: string; status: number | null }> = r.redirectChain;
  const engine: 'direct-fetch' | 'lightpanda' | 'puppeteer' | 'pdf' | null = r.engine;
  const final: string = r.finalUrl;
  const ok: boolean = r.transportSuccess;
  void chain; void engine; void final; void ok;
  const ai = await scraper.askAI('https://example.com', 'q', { aiEndpoint: 'https://my.ai/answer', aiApiKey: 'k' });
  if (ai.usage) { const tokens: number | null = ai.usage.inputTokens; void tokens; }
  const quick: ScrapingResult = await smartScrape('https://example.com', { deadline: 1000 } satisfies ScrapingOptions);
  void quick;
  const stats = getBrowserPoolStats();
  const pending: number = stats.pending;
  void pending;
  await scraper.cleanup();
}

async function lightpandaAndChromeDom(): Promise<void> {
  const opts: BrowserSessionOptions = { mode: 'chrome', isolate: true, recordTypedText: false, deadline: 60000, maxStateElements: 80 };
  const session: BrowserSession = await createSession(opts);
  const nav: ActionResult = await session.goto('https://example.com');
  const code: number | null | undefined = nav.httpStatus;
  void code;
  const click: ActionResult = await session.click('#submit', { waitForNavigation: true });
  if (click.outcome === 'uncertain') console.log(click.uncertainReason);
  const state: PageState = await session.getPageState({ maxElements: 20, offset: 0, includeValues: false });
  const first = state.elements[0];
  if (first) { const sel: string = first.selector; const inv: boolean = first.invalid; void sel; void inv; }
  const total: number = state.truncated.total;
  void total;
  const cp: Checkpoint = await session.checkpoint();
  const restored: RestoreResult = await session.restore(cp);
  void restored.skipped;
  const frames = await session.frames();
  if (frames[1]) await session.useFrame(frames[1].id);
  session.useMainFrame();
  const pages = await session.pages();
  if (pages[1]) await session.usePage(pages[1].index);
  await session.uploadFile('#cv', ['/tmp/a.pdf', { name: 'b.pdf', data: new Uint8Array(1), mimeType: 'application/pdf' }]);
  await session.enableDownloads({ dir: '/tmp/dl', maxBytes: 1000 });
  const dl: DownloadRecord = await session.waitForDownload({ timeout: 1000 });
  void dl.path;
  session.setDialogHandler({ action: 'accept', promptText: 'x' });
  session.setDialogHandler(async (d) => ({ action: d.type === 'confirm' ? 'accept' : 'dismiss' }));
  const cookies = await session.getCookies();
  void cookies;
  await session.close();
}

async function computerUse(): Promise<void> {
  const provider: ComputerUseProvider = new LocalProvider({ enableVnc: true, vnc: { bind: '127.0.0.1', password: null }, noSandbox: true, screenWidth: 1280, screenHeight: 800 });
  const session = await createSession({ mode: 'computer-use', provider });
  const info: ProviderInfo | null = session.getProviderInfo();
  if (info?.vnc) { const loop: boolean = info.vnc.loopbackOnly; void loop; }
  const geo: SessionGeometry = await session.calibrate({ timeout: 1000 });
  void geo.offset.x;
  await session.clickAt(10, 20, { space: 'page', button: 'left' });
  await session.clickAt(10, 20, 'right');
  await session.drag(0, 0, 10, 10, { space: 'page', steps: 5 });
  await session.scrollAt(5, 5, 'down', 3, { space: 'desktop' });
  const shot = await session.screenshot({ space: 'desktop' });
  const space: 'desktop' | 'page' = shot.coordinateSpace;
  void space;
  await session.pressKey('Enter');
  await session.desktopKey('Control+Shift+ArrowLeft');
  await session.desktopType('hello');
  const typed = await session.typeText('abc');
  if (typed.outcome === 'uncertain') console.log(typed.uncertainReason);
  const caps = await provider.getCapabilities();
  const desktop: boolean = caps.desktopScreenshot;
  void desktop;
  const ps: ProviderScreenshot = await provider.screenshot({ space: 'page' });
  void ps.dpr;
  await session.close();
}

async function infrastructure(): Promise<void> {
  const pool = new BrowserPool({ maxInstances: 2, maxQueue: 10, acquireTimeout: 1000, launch: { noSandbox: false } });
  try {
    const b = await pool.getBrowser({ timeout: 500, signal: new AbortController().signal });
    pool.releaseBrowser(b);
  } catch (e) {
    if (e instanceof PoolAcquireTimeoutError) console.log(e.code);
  }
  const args: string[] = buildLaunchArgs({ noSandbox: true, extraArgs: ['--lang=en'] });
  void args;
  await pool.shutdown();
  const d = Deadline.from(1000);
  const left: number = d.remaining();
  const t: number = d.stageTimeout(500);
  void left; void t;
  try { d.throwIfExpired(); } catch (e) { if (e instanceof DeadlineError) console.log(e.code); }
  d.dispose();
  const cls = classifyContent({ httpStatus: 403, html: '<p>Access Denied</p>' });
  const reason: string | undefined = cls.reasons[0];
  void reason;
  const report: CapabilityReport = await checkCapabilities();
  if (!report.modes.computerUse) { const miss = report.missing[0]; if (miss) console.log(miss.install); }
  try { throw new CapabilityError('xdotool', 'apt-get install xdotool'); } catch (e) { if (e instanceof CapabilityError) console.log(e.install); }
  const trace = new Trace({ operation: 'custom' });
  trace.stage('s').end({ outcome: 'ok', httpStatus: 200 });
  const rec: TraceRecord = trace.finish({ outcome: 'ok' });
  void rec.stages.length;
  const safe: string = redactUrl('https://x/?token=a');
  const sensitive: boolean = isSensitiveField({ type: 'password' });
  const key: string = normalizeXdoKey('Enter');
  const v: string = LIGHTPANDA_VERSION;
  const kind: 'safe' | 'mutating' = ACTION_KIND.SAFE;
  const minChars: number = MIN_USABLE_TEXT_CHARS + SHELL_TEXT_CHARS;
  void minChars;
  void safe; void sensitive; void key; void v; void kind;
  const inst = await installLightpanda({ skip: true });
  const st: 'installed' | 'present' | 'skipped' | 'unsupported' | 'failed' = inst.status;
  void st;
}

void httpAndEngines; void lightpandaAndChromeDom; void computerUse; void infrastructure;
