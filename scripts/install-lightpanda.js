#!/usr/bin/env node

import fs from 'fs';
import https from 'https';
import path from 'path';
import { createWriteStream } from 'fs';
import { execSync } from 'child_process';

const LIGHTPANDA_VERSION = 'nightly';
const BINARY_DIR = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'bin');
const BINARY_NAME = 'lightpanda';
const BINARY_PATH = path.join(BINARY_DIR, BINARY_NAME);

// Platform-specific download URLs (matching official Lightpanda instructions)
const DOWNLOAD_URLS = {
  'darwin': `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-aarch64-macos`,
  'linux': `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux`,
  'wsl': `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux` // WSL uses Linux binary
};

function detectPlatform() {
  const platform = process.platform;
  
  if (platform === 'darwin') {
    return 'darwin';
  }
  
  if (platform === 'linux') {
    return 'linux';
  }
  
  if (platform === 'win32') {
    // Check if we're running in WSL
    try {
      const uname = execSync('uname -r', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (uname.toLowerCase().includes('microsoft') || uname.toLowerCase().includes('wsl')) {
        console.log('🐧 WSL detected - using Linux binary');
        return 'wsl';
      }
    } catch {
      // Not in WSL or uname not available
    }
    
    console.log('⚠️  Windows detected. Lightpanda is recommended to run in WSL2.');
    console.log('   Please install WSL2 and run this package from within WSL2.');
    console.log('   See: https://docs.microsoft.com/en-us/windows/wsl/install');
    return null;
  }
  
  return null;
}

async function downloadFile(url, destination) {
  console.log(`📥 Downloading Lightpanda binary from: ${url}`);
  
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, destination).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      const fileStream = createWriteStream(destination);
      const totalSize = parseInt(response.headers['content-length'] || '0');
      let downloadedSize = 0;
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
          const progress = (downloadedSize / totalSize * 100).toFixed(1);
          process.stdout.write(`\r⏳ Progress: ${progress}%`);
        }
      });
      
      response.on('end', () => {
        process.stdout.write('\r✅ Download completed!           \n');
      });
      
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', reject);
    });
    
    request.on('error', reject);
    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

async function makeExecutable(filePath) {
  try {
    await fs.promises.chmod(filePath, 0o755);
    console.log(`🔧 Made ${filePath} executable`);
  } catch (error) {
    console.warn(`⚠️  Warning: Could not make binary executable: ${error.message}`);
  }
}

async function installLightpanda() {
  try {
    const platform = detectPlatform();
    
    if (!platform) {
      console.log('   Falling back to Puppeteer for browser-based scraping.');
      return;
    }
    
    const downloadUrl = DOWNLOAD_URLS[platform];
    
    if (!downloadUrl) {
      console.log(`⚠️  Lightpanda binary not available for platform: ${platform}`);
      console.log('   Falling back to Puppeteer for browser-based scraping.');
      return;
    }
    
    // Create bin directory if it doesn't exist
    if (!fs.existsSync(BINARY_DIR)) {
      await fs.promises.mkdir(BINARY_DIR, { recursive: true });
      console.log(`📁 Created directory: ${BINARY_DIR}`);
    }
    
    // Check if binary already exists
    if (fs.existsSync(BINARY_PATH)) {
      console.log(`✅ Lightpanda binary already exists at: ${BINARY_PATH}`);
      await makeExecutable(BINARY_PATH);
      return;
    }
    
    console.log(`🚀 Installing Lightpanda binary for ${platform}...`);
    
    // Download the binary
    await downloadFile(downloadUrl, BINARY_PATH);
    
    // Make executable (all Unix-like systems including WSL)
    await makeExecutable(BINARY_PATH);
    
    // Verify the binary
    if (fs.existsSync(BINARY_PATH)) {
      const stats = await fs.promises.stat(BINARY_PATH);
      console.log(`✅ Lightpanda binary installed successfully!`);
      console.log(`   Location: ${BINARY_PATH}`);
      console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // Additional WSL information
      if (platform === 'wsl') {
        console.log('');
        console.log('📝 WSL Setup Notes:');
        console.log('   - Lightpanda binary installed for WSL environment');
        console.log('   - Ensure your Node.js application runs within WSL2');
        console.log('   - For best performance, keep files within WSL filesystem');
      }
    } else {
      throw new Error('Binary download verification failed');
    }
    
  } catch (error) {
    console.error(`❌ Failed to install Lightpanda binary: ${error.message}`);
    console.log('   The package will fall back to Puppeteer for browser-based scraping.');
    
    // Don't fail the installation, just log the issue
    process.exit(0);
  }
}

// Only run if this is the main module (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  installLightpanda().catch((error) => {
    console.error('Installation failed:', error);
    process.exit(0); // Don't fail package installation
  });
} 