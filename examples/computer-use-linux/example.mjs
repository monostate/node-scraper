import { createSession, LocalProvider, checkCapabilities } from '@monostate/node-scraper';

const caps = await checkCapabilities();
if (!caps.modes.computerUse) {
  console.error('computer-use not available:', caps.missing);
  process.exit(1);
}

const provider = new LocalProvider({ enableVnc: true, screenWidth: 1280, screenHeight: 800 });
const session = await createSession({ mode: 'computer-use', provider });
const info = session.getProviderInfo();
console.log('display:', info.display);
console.log('vnc (loopback only, attach your own authenticated viewer):', info.vnc);

await session.goto('https://example.com');
const geometry = await session.calibrate();
console.log('page->desktop offset:', geometry.offset, 'method:', geometry.method);

const state = await session.getPageState({ maxElements: 10 });
const link = state.elements.find(e => e.role === 'link');
if (link) {
  const { x, y, width, height } = link.bounds;
  await session.clickAt(x + width / 2, y + height / 2, { space: 'page' });
  console.log('clicked', link.text, '→', await session.evaluate(() => location.href));
}

const shot = await session.screenshot({ space: 'desktop' });
console.log('desktop screenshot:', shot.width, 'x', shot.height, shot.coordinateSpace);

await session.close();
