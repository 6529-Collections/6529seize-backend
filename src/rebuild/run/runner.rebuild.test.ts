import * as path from 'node:path';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { headline } from '@/rebuild/report/report';
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
    final?: boolean;
  }
) {
  // Only the self-check's own steps and probe: the areas' steps and probes
  // answer for the areas, in area and integration runs, not for the
  // harness, and one area's steps may wait on another's.
  const manifests: AreaManifest[] = AREA_MANIFESTS.map((manifest) =>
    manifest.area === area
      ? {
          ...manifest,
          seeds: [parts.seed],
          rebuilders: [parts.rebuilder],
          probes: parts.probes ?? []
        }
      : { ...manifest, seeds: [], rebuilders: [], probes: [] }
  );
  return runRebuildCheck({
    repoRoot: path.resolve(__dirname, '..', '..', '..'),
    home: HOME,
    manifests,
    area,
    mark: 'head',
    final: parts.final ?? false,
    mysqlPort: PORT,
    apiPort: 0,
    sources: {},
    chainHeight: null,
    ethBlock: null,
    log: () => undefined
  });
}

const teamSeed = step('self-check.seed', 'seedTeam', ['team']);

function teamRun(rebuilder: RebuildStep, final = false) {
  return run('mint', { seed: teamSeed, rebuilder, final });
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
    expect(report.probes.stoppedBefore).toBeNull();
  });

  it('reports rows that differ after the rebuild, and passes', async () => {
    const { report } = await teamRun(
      step('self-check.renamed', 'rebuildTeamDifferently', ['team'])
    );
    const [diff] = report.tables.diffs;
    expect(diff.same).toBe(false);
    expect(diff.changed).toHaveLength(3);
    expect(report.notes.join(' ')).toContain('differ row by row');
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('fails a final run on rows that differ after the rebuild', async () => {
    const { report } = await teamRun(
      step('self-check.renamed-final', 'rebuildTeamDifferently', ['team']),
      true
    );
    expect(report.verdict).toBe('FAIL');
    expect(report.failures).toContainEqual(
      expect.stringContaining('1 rebuilt tables differ row by row')
    );
    expect(report.notes.join(' ')).not.toContain('differ row by row');
  });

  it('fails a rebuilder that reads a table it did not declare', async () => {
    const { report } = await teamRun(
      step('self-check.undeclared', 'readUndeclaredTable', ['team'])
    );
    expect(report.verdict).toBe('FAIL');
    expect(report.failures.join(' ')).toContain(
      'rebuilder self-check.undeclared exited with 1'
    );
    // The run stopped before pass B: no comparison to report.
    expect(report.probes.stoppedBefore).toBe(
      'step rebuilder self-check.undeclared'
    );
    expect(headline(report)[2]).toContain(
      'not compared: the run stopped before pass B (step rebuilder self-check.undeclared)'
    );
  });

  it('passes the same rebuilder once it declares the read', async () => {
    const { report } = await teamRun(
      step('self-check.declared', 'readUndeclaredTable', ['team'], ['nfts'])
    );
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('skips a step as planned while a table it needs is not in the schema', async () => {
    // A manifest table (identity's planned mirror table) no code creates yet.
    const waiting = (id: string): RebuildStep => ({
      ...step(id, 'rebuildTeam', ['team']),
      needs: [
        {
          table: 'identity_chain_principals',
          reason: 'the identity mirror creates it'
        }
      ]
    });
    const { report } = await teamRun(waiting('self-check.waiting'));
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('PASS');
    expect(report.steps.map((s) => s.id)).not.toContain('self-check.waiting');
    // Its table was kept, like a planned rebuilder's.
    expect(report.tables.rebuilt).toEqual([]);
    expect(report.notes.join(' ')).toContain(
      'self-check.waiting needs identity_chain_principals (the identity mirror creates it)'
    );
    const final = await teamRun(waiting('self-check.waiting-final'), true);
    expect(final.report.verdict).toBe('FAIL');
    expect(final.report.failures.join(' ')).toContain(
      'self-check.waiting-final needs identity_chain_principals'
    );
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
