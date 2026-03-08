import { spawn } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import fs from 'fs';

class LightPandaServer {
  constructor(binaryPath) {
    this.binaryPath = binaryPath || this._findBinary();
    this.process = null;
    this.host = '127.0.0.1';
    this.port = null;
    this.ready = false;
  }

  async start(port) {
    if (this.process && this.ready) return this.getEndpoint();

    this.port = port || await this._findAvailablePort();

    return new Promise((resolve, reject) => {
      const args = [
        'serve',
        '--host', this.host,
        '--port', String(this.port),
        '--cdp_max_connections', '16',
      ];

      this.process = spawn(this.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      const onReady = () => {
        this.ready = true;
        resolve(this.getEndpoint());
      };

      // LP prints to stderr when ready — wait for it or poll /json/version
      this.process.stderr.on('data', (data) => {
        stderr += data.toString();
        // LightPanda logs server start to stderr
        if (stderr.includes('Listening on') || stderr.includes('server started')) {
          onReady();
        }
      });

      this.process.on('error', (err) => {
        this.ready = false;
        reject(new Error(`Failed to start LightPanda: ${err.message}`));
      });

      this.process.on('exit', (code) => {
        this.ready = false;
        this.process = null;
        if (!this.ready) {
          reject(new Error(`LightPanda exited with code ${code}: ${stderr}`));
        }
      });

      // Fallback: poll /json/version if no stderr signal within 3s
      setTimeout(async () => {
        if (this.ready) return;
        try {
          const res = await fetch(`http://${this.host}:${this.port}/json/version`);
          if (res.ok) onReady();
        } catch {
          // Still starting up, give it more time
        }
      }, 1500);

      // Hard timeout
      setTimeout(() => {
        if (!this.ready) {
          this.stop();
          reject(new Error(`LightPanda failed to start within 5s. stderr: ${stderr}`));
        }
      }, 5000);
    });
  }

  getEndpoint() {
    return `ws://${this.host}:${this.port}`;
  }

  isRunning() {
    return this.ready && this.process !== null;
  }

  stop() {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // already dead
      }
      this.process = null;
    }
    this.ready = false;
    this.port = null;
  }

  async _findAvailablePort() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  _findBinary() {
    // Check common locations
    const candidates = [
      path.join(path.dirname(new URL(import.meta.url).pathname), 'bin', 'lightpanda'),
      '/usr/local/bin/lightpanda',
      '/usr/bin/lightpanda',
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    return 'lightpanda'; // hope it's on PATH
  }
}

// Singleton instance — shared across all sessions
let _instance = null;

export function getLightPandaServer(binaryPath) {
  if (!_instance) {
    _instance = new LightPandaServer(binaryPath);
  }
  return _instance;
}

export function stopLightPandaServer() {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}

process.on('SIGTERM', stopLightPandaServer);
process.on('SIGINT', stopLightPandaServer);
process.on('beforeExit', stopLightPandaServer);

export default LightPandaServer;
