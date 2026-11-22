import * as path from 'node:path';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { runRebuildCheck } from '@/rebuild/run/runner';

// The harness's end-to-end check: a private mysqld, the schema from code,
// the API, and single-area runs whose rebuilders pass, differ, read an undeclared
// table or call an outside host. Runs with scripts/rebuild-jest.config.cjs,
// outside the shards; each run takes a minute or two.

const HOME =
  process.env.REBUILD_SELF_CHECK_HOME ??
  path.resolve(__dirname, '..', '..', '..', '.rebuild', 'self-check');
const PORT = Number(process.env.REBUILD_SELF_CHECK_PORT ?? 3407);
const MODULE = 'src/rebuild/run/self-check.steps';

function step(
  id: string,
  exportName: string,
  writes: string[],
  reads?: string[]
): RebuildStep {
  return {
    id,
    run: { module: MODULE, exportName },
    writes,
    reads,
    sources: ['repo'],
    timeoutMinutes: 5
  };
}

function run(
  area: string,
  parts: {
    seed: RebuildStep;
    rebuilder: RebuildStep;
    probes?: Probe[];
  }
) {
  // Only the self-check's own probe: the areas' probes answer for the
  // areas, in area and integration runs, not for the harness.
  const manifests: AreaManifest[] = AREA_MANIFESTS.map((manifest) =>
    manifest.area === area
      ? {
          ...manifest,
          seeds: [parts.seed],
          rebuilders: [parts.rebuilder],
          probes: parts.probes ?? []
        }
      : { ...manifest, probes: [] }
  );
  return runRebuildCheck({
    repoRoot: path.resolve(__dirname, '..', '..', '..'),
    home: HOME,
    manifests,
    area,
    mark: 'head',
    final: false,
    mysqlPort: PORT,
    apiPort: 0,
    sources: {},
    chainHeight: null,
    ethBlock: null,
    log: () => undefined
  });
}

const teamSeed = step('self-check.seed', 'seedTeam', ['team']);

function teamRun(rebuilder: RebuildStep) {
  return run('mint', { seed: teamSeed, rebuilder });
}

describe('rebuild check, end to end', () => {
  it('passes when the rebuilder restores the seeded rows', async () => {
    const { report } = await teamRun(
      step('self-check.same', 'rebuildTeam', ['team'])
    );
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('PASS');
    expect(report.tables.rebuilt).toEqual(['team']);
    expect(
      report.tables.diffs.map((d) => [d.table, d.same, d.rowsAfter])
    ).toEqual([['team', true, 3]]);
    expect(
      report.steps.find((s) => s.kind === 'rebuilder')?.rowsWritten
    ).toEqual({ team: 3 });
  });

  it('reports rows that differ after the rebuild', async () => {
    const { report } = await teamRun(
      step('self-check.renamed', 'rebuildTeamDifferently', ['team'])
    );
    const [diff] = report.tables.diffs;
    expect(diff.same).toBe(false);
    expect(diff.changed).toHaveLength(3);
    expect(report.notes.join(' ')).toContain('differ row by row');
  });

  it('fails a rebuilder that reads a table it did not declare', async () => {
    const { report } = await teamRun(
      step('self-check.undeclared', 'readUndeclaredTable', ['team'])
    );
    expect(report.verdict).toBe('FAIL');
    expect(report.failures.join(' ')).toContain(
      'rebuilder self-check.undeclared exited with 1'
    );
  });

  it('passes the same rebuilder once it declares the read', async () => {
    const { report } = await teamRun(
      step('self-check.declared', 'readUndeclaredTable', ['team'], ['nfts'])
    );
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('fails a rebuilder that calls a host outside the sources', async () => {
    const { report } = await teamRun(
      step('self-check.outside', 'callOutsideSource', ['team'])
    );
    expect(report.verdict).toBe('FAIL');
    expect(report.violations.map((v) => v.target)).toEqual(['192.0.2.1:80']);
    expect(report.failures.join(' ')).toContain(
      'connections to sources outside the list'
    );
  });

  describe('through the API', () => {
    const seasonsProbe: Probe = {
      id: 'self-check.seasons',
      path: '/api/new_memes_seasons'
    };
    const seasonsSeed = step('self-check.seasons-seed', 'seedSeasons', [
      'memes_seasons'
    ]);

    it('passes when the API answers the same after the rebuild', async () => {
      const { report } = await run('holdings', {
        seed: seasonsSeed,
        rebuilder: step('self-check.seasons', 'rebuildSeasons', [
          'memes_seasons'
        ]),
        probes: [seasonsProbe]
      });
      expect(report.failures).toEqual([]);
      expect(report.verdict).toBe('PASS');
      expect(report.probes.calls).toBe(1);
      expect(report.probes.unreadTables).toEqual([]);
    });

    it('fails when the API answers differently after the rebuild', async () => {
      const { report } = await run('holdings', {
        seed: seasonsSeed,
        rebuilder: step(
          'self-check.seasons-shifted',
          'rebuildSeasonsDifferently',
          ['memes_seasons']
        ),
        probes: [seasonsProbe]
      });
      expect(report.verdict).toBe('FAIL');
      expect(report.probes.differences.map((d) => [d.id, d.reason])).toEqual([
        ['self-check.seasons', 'the answers differ']
      ]);
    });
  });
});
