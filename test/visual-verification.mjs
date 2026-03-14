import { createSession } from '../browser-session.js';
import { stopLightPandaServer } from '../lightpanda-server.js';
import browserPool from '../browser-pool.js';
import fs from 'fs';
import path from 'path';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

function save(name, dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, buf);
  const kb = (buf.length / 1024).toFixed(1);
  console.log(`  saved: ${file} (${kb} KB)`);
}

async function run() {
  const session = await createSession({ mode: 'visual', verbose: true });

  try {
    // 1. Navigate to example.com
    console.log('\n--- Step 1: Navigate to example.com ---');
    await session.goto('https://example.com');
    let shot = await session.screenshot();
    save('01-example-com', shot.screenshot);

    // 2. Navigate to httpbin forms page
    console.log('\n--- Step 2: Navigate to httpbin forms ---');
    await session.goto('https://httpbin.org/forms/post');
    shot = await session.screenshot();
    save('02-httpbin-form-empty', shot.screenshot);

    // 3. Fill out the form
    console.log('\n--- Step 3: Fill form fields ---');
    const state = await session.getPageState();
    console.log('  Interactive elements:', state.interactiveElements.length);
    state.interactiveElements.forEach(el => {
      console.log(`    ${el.type}: ${el.label || el.text || el.selector}`);
    });

    // Type into the custname field
    await session.type('input[name="custname"]', 'John Doe');
    await session.type('input[name="custtel"]', '555-1234');
    await session.type('input[name="custemail"]', 'john@example.com');
    // Select a pizza size
    await session.click('input[value="medium"]');
    // Add a comment
    await session.type('textarea[name="comments"]', 'Extra cheese please! This is a test of the browser session.');
    shot = await session.screenshot();
    save('03-httpbin-form-filled', shot.screenshot);

    // 4. Submit the form
    console.log('\n--- Step 4: Submit form ---');
    await session.click('button', { waitForNavigation: true });
    // Wait a moment for the response page
    await new Promise(r => setTimeout(r, 1000));
    shot = await session.screenshot();
    save('04-httpbin-form-submitted', shot.screenshot);

    // 5. Navigate to Wikipedia
    console.log('\n--- Step 5: Navigate to Wikipedia ---');
    await session.goto('https://en.wikipedia.org/wiki/Main_Page');
    shot = await session.screenshot({ fullPage: false });
    save('05-wikipedia-main', shot.screenshot);

    // 6. Type into Wikipedia search
    console.log('\n--- Step 6: Search Wikipedia ---');
    await session.type('#searchInput', 'LightPanda browser');
    shot = await session.screenshot({ fullPage: false });
    save('06-wikipedia-search-typed', shot.screenshot);

    // 7. Submit search
    console.log('\n--- Step 7: Submit search ---');
    await session.pressKey('Enter');
    await new Promise(r => setTimeout(r, 2000));
    shot = await session.screenshot({ fullPage: false });
    save('07-wikipedia-search-results', shot.screenshot);

    // 8. Scroll down
    console.log('\n--- Step 8: Scroll down ---');
    await session.scroll('down', 800);
    await new Promise(r => setTimeout(r, 500));
    shot = await session.screenshot({ fullPage: false });
    save('08-wikipedia-scrolled', shot.screenshot);

    // 9. Go back
    console.log('\n--- Step 9: Go back ---');
    await session.goBack();
    await new Promise(r => setTimeout(r, 1000));
    shot = await session.screenshot({ fullPage: false });
    save('09-wikipedia-back', shot.screenshot);

    // 10. Navigate to a page with more visual content
    console.log('\n--- Step 10: Navigate to Hacker News ---');
    await session.goto('https://news.ycombinator.com');
    shot = await session.screenshot({ fullPage: false });
    save('10-hackernews', shot.screenshot);

    // 11. Click first article link
    console.log('\n--- Step 11: Click first HN story ---');
    const hnState = await session.getPageState();
    const storyLink = hnState.interactiveElements.find(el =>
      el.type === 'link' && el.selector.includes('titleline')
    );
    if (storyLink) {
      console.log(`  Clicking: ${storyLink.text}`);
      await session.click(storyLink.selector);
      await new Promise(r => setTimeout(r, 2000));
    }
    shot = await session.screenshot({ fullPage: false });
    save('11-hackernews-article', shot.screenshot);

    // Summary
    console.log('\n=== Summary ===');
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png'));
    let totalKB = 0;
    for (const f of files) {
      const size = fs.statSync(path.join(OUT_DIR, f)).size;
      totalKB += size / 1024;
      console.log(`  ${f}: ${(size / 1024).toFixed(1)} KB`);
    }
    console.log(`  Total: ${files.length} screenshots, ${totalKB.toFixed(0)} KB`);
    console.log(`\nOpen folder: ${OUT_DIR}`);

  } finally {
    await session.close();
    await browserPool.closeAll();
    stopLightPandaServer();
  }
}

run().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
