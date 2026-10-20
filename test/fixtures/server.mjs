/**
 * Controlled local fixture server for node-scraper tests.
 *
 * Every behavior the test-suite needs (cookie/CSRF forms, JS-only forms,
 * uploads, downloads, status codes, redirects, frames, shadow DOM, dialogs,
 * password fields, many controls, ambiguous POSTs) lives here so no test
 * depends on a public website.
 */
import http from 'node:http';
import { once } from 'node:events';

const STYLE = `<style>body{font:18px system-ui;margin:32px;background:#f4f5f7;color:#182330}main{max-width:850px;background:white;padding:28px;border:1px solid #ccd3db}h1{font-size:28px}label{display:block;margin:16px 0 5px}input,select,textarea,button{font:inherit;padding:12px;border:1px solid #74869b;border-radius:5px}button{background:#143f67;color:white;margin-top:18px;cursor:pointer}input[type=checkbox]{width:22px;height:22px}#status{padding:12px;background:#e5f0e8}a{color:#164b80}</style>`;

const wrap = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body><main><h1>${title}</h1><p>Controlled local QA fixture. No employer receives this data.</p>${body}</main></body></html>`;

function form(full) {
  return `<form id="application" method="post" action="/submit"${full ? ' enctype="multipart/form-data"' : ''}>
<input type="hidden" name="csrf" value="local-audit-token">
<label for="name">Full name</label><input id="name" name="name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="country">Country</label><select id="country" name="country" required><option value="">Choose</option><option value="UK">United Kingdom</option><option value="BR">Brazil</option></select>
<label for="cover">Cover letter</label><textarea id="cover" name="cover" required></textarea>
${full ? '<label for="cv">CV PDF</label><input type="file" id="cv" name="cv" accept=".pdf" required>' : ''}
<label><input id="consent" type="checkbox" name="consent" required> This is a local test submission only.</label>
<button id="submit" type="submit">Submit local test application</button></form>`;
}

const INTERACTION_BODY = `
<div id="click-target" style="position:absolute;left:100px;top:200px;width:240px;height:80px;background:#ccdfed;border:2px solid #183753;display:grid;place-items:center">Click target</div>
<label for="cursor-input" style="position:absolute;left:100px;top:320px">Cursor input</label>
<input id="cursor-input" style="position:absolute;left:100px;top:360px;width:300px">
<div id="drag-source" draggable="true" style="position:absolute;left:100px;top:480px;width:140px;height:80px;background:#ffe0a0;display:grid;place-items:center">Drag me</div>
<div id="drop-target" style="position:absolute;left:400px;top:480px;width:200px;height:80px;background:#d7efdc;display:grid;place-items:center">Drop here</div>
<div id="scroll-box" style="position:absolute;left:760px;top:200px;width:320px;height:350px;overflow:auto;border:3px solid #183753"><div style="height:1600px;padding:20px">Scrollable panel</div></div>
<p style="position:absolute;left:100px;top:600px">All events are recorded as browser evidence.</p>
<script>
window.auditEvents=[];window.dropCount=0;
['click','dblclick','contextmenu','keydown','input','pointerdown','pointerup','dragstart','dragover','drop','mousemove'].forEach(type=>document.addEventListener(type,e=>{
  window.auditEvents.push({type,target:e.target.id,clientX:e.clientX,clientY:e.clientY,screenX:e.screenX,screenY:e.screenY,key:e.key,trusted:e.isTrusted});
  if(type==='contextmenu')e.preventDefault();
}));
document.getElementById('drag-source').ondragstart=e=>e.dataTransfer.setData('text/plain','QA drag');
document.getElementById('drop-target').ondragover=e=>e.preventDefault();
document.getElementById('drop-target').ondrop=e=>{e.preventDefault();window.dropCount++;e.target.textContent='Drop received'};
</script>`;

const CONTENT_BODY = `
<article>
<h1>Local article fixture</h1>
<p>${'This paragraph exists so the fixture has enough real text to be classified as usable content. '.repeat(4)}</p>
<p>${'A second paragraph with more words about the controlled fixture used by the node-scraper test-suite. '.repeat(4)}</p>
<h2>Details</h2>
<p>${'Details paragraph with additional sentences so the body text comfortably exceeds the minimum size. '.repeat(3)}</p>
<a href="/forms/basic">Basic form</a>
</article>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Local article fixture"}</script>`;

const FRAMES_BODY = `
<iframe name="inner" id="inner" src="/frames/inner" style="width:400px;height:200px"></iframe>
<qa-widget id="widget"></qa-widget>
<a id="new-tab" target="_blank" href="/content">Open content in new tab</a>
<script>
class QaWidget extends HTMLElement {
  constructor(){ super(); const root=this.attachShadow({mode:'open'});
    root.innerHTML='<button id="shadow-btn">Shadow button</button><input type="password" id="shadow-pass" name="shadow-pass" value="s3cret">'; 
    root.getElementById('shadow-btn').onclick=()=>{ document.title='shadow clicked'; };
  }
}
customElements.define('qa-widget', QaWidget);
</script>`;

const DIALOGS_BODY = `
<button id="alert" onclick="alert('hello'); document.getElementById('result').textContent='alert done'">Alert</button>
<button id="confirm" onclick="document.getElementById('result').textContent='confirm:'+confirm('ok?')">Confirm</button>
<button id="prompt" onclick="document.getElementById('result').textContent='prompt:'+prompt('name?','default')">Prompt</button>
<p id="result"></p>`;

const PASSWORD_BODY = `
<form><label for="user">User</label><input id="user" name="username" value="">
<label for="pw">Password</label><input type="password" id="pw" name="password">
<label for="otp">One-time code</label><input id="otp" name="otp" autocomplete="one-time-code">
<button id="login" type="button">Login</button></form>`;

function manyControls() {
  let html = '<div>';
  for (let i = 1; i <= 120; i++) html += `<button class="b">Item ${i % 10}</button>`;
  html += '<button id="we!rd:id">Weird id</button></div>';
  return html;
}

function parseUrlEncoded(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function parseMultipartFieldNames(raw) {
  const out = {};
  const re = /name="([^"]+)"(?:; filename="([^"]*)")?\r?\n(?:[^\r\n]*\r?\n)*?\r?\n([\s\S]*?)(?=\r?\n--)/g;
  let m;
  while ((m = re.exec(raw))) {
    out[m[1]] = m[2] !== undefined ? `<file:${m[2]}>` : m[3];
  }
  return out;
}

export async function startFixtureServer({ port = 0 } = {}) {
  const submissions = []; // valid writes only
  const attempts = [];    // every POST, valid or not
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, at: Date.now(), cookie: req.headers.cookie || '' });
    // No keep-alive: Chromium silently re-sends a request (even a POST) when a
    // *reused* socket dies before a response arrives. Fresh sockets make the
    // dropped-response fixture observe exactly the writes the client issued.
    res.setHeader('Connection', 'close');

    const html = (status, title, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(wrap(title, body));
    };
    const page = (title, body) => html(200, title, body, { 'Set-Cookie': 'qa-session=local-audit; Path=/; SameSite=Lax' });

    if (req.method === 'POST' && (url.pathname === '/submit' || url.pathname === '/submit-drop')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('latin1');
      const contentType = req.headers['content-type'] || '';
      const fields = contentType.startsWith('multipart/') ? parseMultipartFieldNames(raw) : parseUrlEncoded(raw);
      const cookie = req.headers.cookie || '';
      const valid = raw.includes('local-audit-token') && cookie.includes('qa-session=local-audit');
      const entry = {
        id: submissions.length + 1,
        at: new Date().toISOString(),
        valid,
        cookie,
        contentType,
        bytes: Buffer.byteLength(raw, 'latin1'),
        hasPdf: raw.includes('%PDF'),
        fields,
        userAgent: req.headers['user-agent'] || '',
        dropped: url.pathname === '/submit-drop',
      };
      attempts.push(entry);
      if (valid) submissions.push(entry);
      if (url.pathname === '/submit-drop') {
        req.socket.destroy();
        return;
      }
      return html(valid ? 200 : 403, valid ? 'Test application received' : 'Invalid session or CSRF token', `<p id="receipt">Receipt ${entry.id}</p>`);
    }

    switch (url.pathname) {
      case '/':
        return page('Node scraper QA', '<a href="/forms/basic">Basic form</a><br><a href="/forms/js">JavaScript form</a><br><a href="/forms/full">File upload form</a><br><a href="/interaction">Cursor controls</a><br><a href="/content">Content</a>');
      case '/forms/basic':
        return page('Mock application form', form(false));
      case '/forms/full':
        return page('Mock application form', form(true));
      case '/forms/js':
        return page('JavaScript application form', `<div id="app"></div><script>document.getElementById('app').innerHTML=${JSON.stringify(form(false))};</script>`);
      case '/interaction':
        return page('Cursor and keyboard verification', INTERACTION_BODY);
      case '/content':
        return page('Local article fixture', CONTENT_BODY);
      case '/frames':
        return page('Frames and shadow DOM', FRAMES_BODY);
      case '/frames/inner':
        return html(200, 'Inner frame', `<button id="inner-btn" onclick="document.title='inner clicked'">Inner button</button>`);
      case '/dialogs':
        return page('Dialogs', DIALOGS_BODY);
      case '/password':
        return page('Login', PASSWORD_BODY);
      case '/many-controls':
        return page('Many controls', manyControls());
      case '/status/empty':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><head><title></title></head><body></body></html>');
      case '/status/shell':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/_next/static/x.js"></script></body></html>');
      case '/status/forbidden':
        return html(403, 'Access Denied', '<p>You don\'t have permission to access this resource.</p>');
      case '/status/challenge':
        return html(200, 'Just a moment...', '<p>Checking your browser before accessing the site.</p>');
      case '/status/redirect':
        res.writeHead(302, { Location: '/status/redirect2' });
        return res.end();
      case '/status/redirect2':
        res.writeHead(301, { Location: '/content' });
        return res.end();
      case '/download':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report.txt"' });
        return res.end('report line\n'.repeat(200));
      case '/slow': {
        const ms = Number(url.searchParams.get('ms') || 0);
        await new Promise(r => setTimeout(r, ms));
        return page('Slow page', `<p>Responded after ${ms} ms. ${'Padding text for usable content classification. '.repeat(5)}</p>`);
      }
      case '/cookie-check':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
      case '/_next/static/x.js':
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end('// shell script');
      default:
        return html(404, 'Not found', `<p>No fixture at ${url.pathname}</p>`);
    }
  });

  // Chromium preconnects idle sockets on navigation and treats them as
  // "reused", which makes it silently re-send a request (even a POST) when
  // such a socket dies without a response. Closing sockets that never send a
  // request keeps the dropped-response fixture observing exactly the writes
  // the client issued.
  server.on('connection', (socket) => {
    const reaper = setTimeout(() => socket.destroy(), 150);
    socket.once('data', () => clearTimeout(reaper));
    socket.once('close', () => clearTimeout(reaper));
  });

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const actualPort = server.address().port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    submissions,
    attempts,
    requests,
    reset() { submissions.length = 0; attempts.length = 0; requests.length = 0; },
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// CLI: node test/fixtures/server.mjs [port]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fx = await startFixtureServer({ port: Number(process.argv[2] || 8080) });
  console.log(`fixture server listening on ${fx.url}`);
}
