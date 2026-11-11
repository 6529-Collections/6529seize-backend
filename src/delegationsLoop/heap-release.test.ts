import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { releaseHeapAfterReconsolidation } from './heap-release';

type GcHolder = { gc?: () => void };

describe('the garbage collection after a reconsolidation', () => {
  afterEach(() => {
    delete (globalThis as GcHolder).gc;
  });

  it('runs a full collection when gc is exposed', () => {
    const gc = jest.fn();
    (globalThis as GcHolder).gc = gc;

    releaseHeapAfterReconsolidation();

    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('only logs when gc is not exposed', () => {
    expect(() => releaseHeapAfterReconsolidation()).not.toThrow();
  });

  it('is exposed to the deployed delegationsLoop through NODE_OPTIONS', () => {
    const config = fs.readFileSync(
      path.join(__dirname, 'serverless.yaml'),
      'utf8'
    );
    const nodeOptions = /^\s*NODE_OPTIONS:\s*(.+)$/m.exec(config)?.[1].trim();
    expect(nodeOptions?.split(/\s+/)).toContain('--expose-gc');
    // Node rejects most V8 flags in NODE_OPTIONS and then fails to start:
    // this one must be accepted, and expose gc.
    const child = spawnSync(
      process.execPath,
      ['-e', "process.exit(typeof gc === 'function' ? 0 : 1)"],
      { env: { ...process.env, NODE_OPTIONS: nodeOptions } }
    );
    expect(child.stderr.toString()).toBe('');
    expect(child.status).toBe(0);
  });
});
