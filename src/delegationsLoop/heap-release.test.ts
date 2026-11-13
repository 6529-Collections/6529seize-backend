import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { collectGarbageAfter } from './heap-release';

type GcHolder = { gc?: () => void };

describe('the garbage collection after a reconsolidation', () => {
  afterEach(() => {
    delete (globalThis as GcHolder).gc;
  });

  it('runs a full collection when gc is exposed', () => {
    const gc = jest.fn();
    (globalThis as GcHolder).gc = gc;

    collectGarbageAfter('RECONSOLIDATION');

    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('only logs when gc is not exposed', () => {
    expect(() => collectGarbageAfter('RECONSOLIDATION')).not.toThrow();
  });

  it('never throws, whatever fails inside', () => {
    (globalThis as GcHolder).gc = () => {
      throw new Error('gc failure');
    };
    expect(() => collectGarbageAfter('IDENTITIES SYNC')).not.toThrow();
    (globalThis as GcHolder).gc = jest.fn();
    const memory = jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('memory read failure');
    });
    try {
      expect(() => collectGarbageAfter('RECONSOLIDATION')).not.toThrow();
    } finally {
      memory.mockRestore();
    }
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
