#!/usr/bin/env bash
# Pack the package, install the tarball into an empty project, and run a
# scrape through the published entry point. Proves the tarball is complete.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$PKG_DIR"
TGZ="$(npm pack --silent --pack-destination "$WORK")"
echo "packed: $TGZ"

# Fixture server from the repo, on a random port
node -e "
import('$PKG_DIR/test/fixtures/server.mjs').then(async m => {
  const fx = await m.startFixtureServer();
  require('fs').writeFileSync('$WORK/fixture-port', String(fx.port));
  setTimeout(() => process.exit(0), 120000);
});
" &
FIXTURE_PID=$!
for _ in $(seq 1 50); do [ -f "$WORK/fixture-port" ] && break; sleep 0.1; done
PORT="$(cat "$WORK/fixture-port")"

cd "$WORK"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$WORK/$TGZ" ${SMOKE_PUPPETEER:+puppeteer@$SMOKE_PUPPETEER}
node --input-type=module -e "
import { BNCASmartScraper, checkCapabilities, LIGHTPANDA_VERSION } from '@monostate/node-scraper';
const caps = await checkCapabilities();
console.log('lightpanda:', caps.lightpanda.available ? caps.lightpanda.version : 'missing', '| expected', LIGHTPANDA_VERSION);
if (!caps.lightpanda.available) process.exit(2);
const s = new BNCASmartScraper({ timeout: 10000 });
const r = await s.scrape('http://127.0.0.1:$PORT/content', { method: 'lightpanda' });
console.log('scrape:', r.success, r.engine, r.httpStatus, r.contentStatus);
if (!r.success) process.exit(3);
const blocked = await s.scrape('http://127.0.0.1:$PORT/status/forbidden', { method: 'direct' });
if (blocked.success || blocked.contentStatus !== 'blocked') process.exit(4);
await s.cleanup();
console.log('smoke ok');
"
kill $FIXTURE_PID 2>/dev/null || true
wait $FIXTURE_PID 2>/dev/null || true
