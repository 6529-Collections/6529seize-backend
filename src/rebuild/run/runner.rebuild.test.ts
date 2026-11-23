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
    /** Rebuilders other areas declare (not run in this area's run). */
    others?: Readonly<Record<string, RebuildStep[]>>;
    /** More rebuilders of the area, after `rebuilder`. */
    more?: RebuildStep[];
    /** A full run of every area, instead of the area's run. */
    full?: boolean;
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
          rebuilders: [parts.rebuilder, ...(parts.more ?? [])],
          probes: parts.probes ?? []
        }
      : {
          ...manifest,
          seeds: [],
          rebuilders: parts.others?.[manifest.area] ?? [],
          probes: []
        }
  );
  return runRebuildCheck({
    repoRoot: path.resolve(__dirname, '..', '..', '..'),
    home: HOME,
    manifests,
    area: parts.full ? null : area,
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

  const partition = (collection: string) => ({
    table: 'team',
    partition: {
      columns: ['collection'],
      values: [[collection]],
      reason: `the ${collection} rows`
    }
  });
  const memes: RebuildStep = {
    ...step('self-check.memes', 'rebuildMemesTeam', []),
    writes: [partition('MEMES')]
  };

  it('runs a step that needs a table the schema has, and notes the need to drop', async () => {
    const { report } = await teamRun({
      ...step('self-check.needs-team', 'rebuildTeam', ['team']),
      needs: [{ table: 'team', reason: 'an entity in this tree creates it' }]
    });
    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('PASS');
    expect(report.steps.map((s) => s.id)).toContain('self-check.needs-team');
    expect(report.tables.rebuilt).toEqual(['team']);
    expect(report.notes.join(' ')).toContain(
      'self-check.needs-team needs team, which the schema now has: drop the need'
    );
    const final = await teamRun(
      {
        ...step('self-check.needs-team-final', 'rebuildTeam', ['team']),
        needs: [{ table: 'team', reason: 'an entity in this tree creates it' }]
      },
      true
    );
    expect(final.report.verdict).toBe('FAIL');
    expect(final.report.failures.join(' ')).toContain(
      'self-check.needs-team-final needs team, which the schema now has: drop the need'
    );
  });

  it('rebuilds only its own partition of a shared table in an area run, and notes rows no partition owns', async () => {
    // Another area's writer of the 6529 rows: not run in a mint-only run,
    // so those rows must stay as seeded.
    const other: RebuildStep = {
      ...step('self-check.other', 'rebuildTeam', []),
      writes: [partition('6529')]
    };
    const shared = await run('mint', {
      seed: teamSeed,
      rebuilder: memes,
      others: { tdh: [other] }
    });
    expect(shared.report.failures).toEqual([]);
    expect(shared.report.verdict).toBe('PASS');
    expect(
      shared.report.tables.diffs.map((d) => [d.table, d.same, d.rowsAfter])
    ).toEqual([['team', true, 3]]);
    expect(shared.report.notes.join(' ')).not.toContain('no rebuilder owns');
    // With no writer of the 6529 rows, that row is owned by no partition.
    const alone = await run('mint', { seed: teamSeed, rebuilder: memes });
    expect(alone.report.notes.join(' ')).toContain(
      "1 partitioned tables hold rows no rebuilder owns after the seeds: team (1 rows whose (collection) is in no writer's partition)"
    );
    // A rebuilder that changes another partition's rows fails the run.
    const trespass = await run('mint', {
      seed: teamSeed,
      rebuilder: {
        ...memes,
        id: 'self-check.trespass',
        run: { module: MODULE, exportName: 'rebuildMemesTeamTouchingOthers' }
      },
      others: { tdh: [other] }
    });
    expect(trespass.report.verdict).toBe('FAIL');
    expect(trespass.report.failures).toContain(
      'rebuilder self-check.trespass changed rows of team outside its partition'
    );
    // MySQL decides overlap, under the column's collation: 'ss' and '\u00df'
    // are one value to utf8mb4_0900_ai_ci, though the registry's fold differs.
    const overlap = await run('mint', {
      seed: teamSeed,
      rebuilder: { ...memes, writes: [partition('ss')] },
      others: { tdh: [{ ...other, writes: [partition('\u00df')] }] }
    });
    expect(overlap.report.verdict).toBe('FAIL');
    expect(overlap.report.failures).toContain(
      "team's partitions overlap under its collation: self-check.memes's (ss) and self-check.other's (\u00df)"
    );
  });

  it("empties a running writer's partition of a table kept for a skipped writer", async () => {
    // The 6529 rows' writer waits for a table no code creates yet, so it is
    // skipped and team is kept for it. The MEMES writer inserts its rows:
    // a duplicate key, unless the kept copy's MEMES rows were deleted
    // first. In an area run and in a full one.
    const skipped: RebuildStep = {
      ...step('self-check.skipped', 'rebuildTeam', []),
      writes: [partition('6529')],
      needs: [
        {
          table: 'identity_chain_principals',
          reason: 'the identity mirror creates it'
        }
      ]
    };
    for (const full of [false, true]) {
      const { report } = await run('mint', {
        seed: teamSeed,
        rebuilder: memes,
        more: [skipped],
        full
      });
      expect([full, report.failures]).toEqual([full, []]);
      expect(report.verdict).toBe('PASS');
      expect(report.steps.map((s) => s.id)).toContain('self-check.memes');
      expect(report.steps.map((s) => s.id)).not.toContain('self-check.skipped');
      expect(
        report.tables.diffs.map((d) => [d.table, d.same, d.rowsAfter])
      ).toEqual([['team', true, 3]]);
    }
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
