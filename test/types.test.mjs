import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

describe('TypeScript consumer compiles against index.d.ts', { timeout: 180000 }, () => {
  it('tsc --noEmit --strict passes for test/types/consumer.ts', async () => {
    try {
      const tsc = path.join(here, '..', 'node_modules', '.bin', 'tsc');
      await exec(tsc, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', path.join(here, 'types', 'consumer.ts')], { cwd: path.join(here, '..'), maxBuffer: 10 * 1024 * 1024 });
    } catch (err) {
      assert.fail(`tsc failed:\n${err.stdout || ''}${err.stderr || ''}`);
    }
  });
});
