import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireHomeLock } from '@/rebuild/stack/home-lock';

describe('home lock', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-lock-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses a second run while the first holds the home', () => {
    const release = acquireHomeLock(home);
    expect(() => acquireHomeLock(home)).toThrow('Another rebuild run');
    release();
    expect(fs.existsSync(path.join(home, 'run.lock'))).toBe(false);
    acquireHomeLock(home)();
  });

  it('takes over a lock whose process has ended', () => {
    // No process has this id on any supported system.
    fs.writeFileSync(path.join(home, 'run.lock'), '2147483646\n');
    const release = acquireHomeLock(home);
    expect(fs.readFileSync(path.join(home, 'run.lock'), 'utf8').trim()).toBe(
      String(process.pid)
    );
    release();
  });
});
