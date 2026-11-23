import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startChild } from '@/rebuild/stack/child-process';

describe('a started child', () => {
  it('stops, and stop() resolves', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-child-'));
    try {
      const child = startChild({
        label: 'sleeper',
        repoRoot: dir,
        command: [process.execPath, '-e', 'setInterval(() => undefined, 1000)'],
        guardLoaded: true,
        env: { PATH: process.env.PATH ?? '' },
        logFile: path.join(dir, 'sleeper.log'),
        timeoutMs: 60_000
      });
      expect(child.pid).not.toBeNull();
      const started = Date.now();
      await child.stop();
      expect(Date.now() - started).toBeLessThan(120_000);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
