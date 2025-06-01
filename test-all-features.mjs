// Test all features of the node-scraper SDK
import { BNCASmartScraper, smartScrape, smartScreenshot, quickShot } from './index.js';

const TEST_URL = 'https://example.com';

async function testAllFeatures() {
  console.log('🧪 Testing @monostate/node-scraper v1.1.0\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Basic scraping
  console.log('1️⃣ Testing smartScrape()...');
  try {
    const result = await smartScrape(TEST_URL, { verbose: true });
    if (result.success && result.content) {
      console.log('✅ Smart scrape successful');
      console.log(`   Method: ${result.method}`);
      console.log(`   Time: ${result.performance.totalTime}ms`);
      passed++;
    } else {
      console.log('❌ Smart scrape failed:', result.error);
      failed++;
    }
  } catch (error) {
    console.log('❌ Smart scrape error:', error.message);
    failed++;
  }
  
  // Test 2: Screenshot
  console.log('\n2️⃣ Testing smartScreenshot()...');
  try {
    const result = await smartScreenshot(TEST_URL);
    if (result.success && result.screenshot) {
      console.log('✅ Screenshot successful');
      console.log(`   Has image: ${!!result.screenshot}`);
      console.log(`   Time: ${result.performance.totalTime}ms`);
      passed++;
    } else {
      console.log('❌ Screenshot failed:', result.error);
      failed++;
    }
  } catch (error) {
    console.log('❌ Screenshot error:', error.message);
    failed++;
  }
  
  // Test 3: Quick shot
  console.log('\n3️⃣ Testing quickShot() [NEW]...');
  try {
    const result = await quickShot(TEST_URL);
    if (result.success && result.screenshot) {
      console.log('✅ Quick shot successful');
      console.log(`   Has image: ${!!result.screenshot}`);
      console.log(`   Time: ${result.performance.totalTime}ms`);
      console.log(`   Method: ${result.method}`);
      passed++;
    } else {
      console.log('❌ Quick shot failed:', result.error);
      failed++;
    }
  } catch (error) {
    console.log('❌ Quick shot error:', error.message);
    failed++;
  }
  
  // Test 4: Class methods
  console.log('\n4️⃣ Testing BNCASmartScraper class methods...');
  const scraper = new BNCASmartScraper({ verbose: false });
  
  try {
    // Test scrape
    const scrapeResult = await scraper.scrape(TEST_URL);
    console.log(`   Scrape: ${scrapeResult.success ? '✅' : '❌'}`);
    
    // Test screenshot
    const screenshotResult = await scraper.screenshot(TEST_URL);
    console.log(`   Screenshot: ${screenshotResult.success ? '✅' : '❌'}`);
    
    // Test quickshot
    const quickshotResult = await scraper.quickshot(TEST_URL);
    console.log(`   Quickshot: ${quickshotResult.success ? '✅' : '❌'}`);
    
    // Test health check
    const health = await scraper.healthCheck();
    console.log(`   Health check: ${health.status === 'healthy' ? '✅' : '❌'}`);
    
    // Test stats
    const stats = scraper.getStats();
    console.log(`   Stats: ✅ (${Object.keys(stats).length} metrics)`);
    
    await scraper.cleanup();
    passed++;
  } catch (error) {
    console.log('❌ Class methods error:', error.message);
    failed++;
  }
  
  // Summary
  console.log('\n\n📊 Test Summary:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed! SDK is ready for publishing.');
  } else {
    console.log('\n⚠️  Some tests failed. Please check Chrome/Chromium installation.');
  }
}

// Run tests
testAllFeatures().catch(console.error);