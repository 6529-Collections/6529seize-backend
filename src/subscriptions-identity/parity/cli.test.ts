import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseArgs } from './cli';
import { BUILD_AT, legacyOutputs, paritySnapshot } from './parity.fixture';

describe('parity cli', () => {
  it('parses commands and flags', () => {
    expect(
      parseArgs(['compare', '--run', 'run2', '--no-pin', '--out', 'r.json'])
    ).toEqual({
      command: 'compare',
      args: { run: 'run2', 'no-pin': true, out: 'r.json' }
    });
    expect(() => parseArgs(['compare', 'stray'])).toThrow(
      'Unexpected argument'
    );
  });

  it('compares saved files and exits 0 when every gate matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subs-parity-'));
    const snapshotPath = join(dir, 'snapshot.json');
    const legacyPath = join(dir, 'legacy.json');
    const outPath = join(dir, 'report.json');
    writeFileSync(snapshotPath, JSON.stringify(paritySnapshot()));
    writeFileSync(legacyPath, JSON.stringify(legacyOutputs()));
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const code = await main([
        'compare',
        '--snapshot',
        snapshotPath,
        '--legacy',
        legacyPath,
        '--build-at',
        new Date(BUILD_AT).toISOString(),
        '--out',
        outPath
      ]);
      expect(code).toBe(0);
    } finally {
      write.mockRestore();
    }
    const reports = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(reports.map((r: { verdict: string }) => r.verdict)).toEqual([
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH',
      'MATCH'
    ]);
  });

  it('prints usage for an unknown command', async () => {
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(await main(['nope'])).toBe(1);
    } finally {
      write.mockRestore();
    }
  });
});
