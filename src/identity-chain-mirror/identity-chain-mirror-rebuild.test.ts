import { RebuildContext } from '@/rebuild/manifest.types';
import { seedProbeIdentities } from '@/rebuild/run/probe-fixture.steps';
import {
  chainGatewayClient,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import { identityManifest } from '@/rebuild/manifests/identity.manifest';
import {
  identityChainMirrorDb,
  IdentityChainMirrorDb,
  MirrorState,
  NO_RETRY
} from './identity-chain-mirror.db';
import {
  IdentityChainMirror,
  MirrorRunReport
} from './identity-chain-mirror.service';
import { createHash } from 'node:crypto';
import {
  caughtUp,
  docsFromFiles,
  MIRROR_RUNS_AT_MOST_MS,
  mirrorToMark,
  MirrorToMarkDeps,
  rebuildIdentityMirror,
  seedIdentityMirror,
  seedPlaceholderReferences
} from './identity-chain-mirror.rebuild';
import {
  fetchPlaceholdersFile,
  readPlaceholdersFile,
  restoreUntakenPlaceholders,
  writePlaceholderList
} from './placeholder-restore';
import { PlaceholderAtFreezeLine } from './placeholders-at-freeze.format';
import { plantPlaceholderReferences } from './rebuild-world/placeholder-references';
import { writePlaceholdersFixture } from './rebuild-world/fixture-file';
import {
  writeSiteRowsAfterSwitchOn,
  writeWavesPeopleTdh,
  writeSiteRowsBeforeSwitchOn
} from './rebuild-world/site-rows';
import {
  fetchSwitchOnRecord,
  loadSwitchOnRecord,
  takeSwitchOnRecord,
  writeSwitchOnRecordFixture
} from './switch-on-record';
import {
  FormattedTdhOnlyRecord,
  formatTdhOnlyRecord,
  TdhOnlyRecord
} from './tdh-only-record';

jest.mock('./switch-on-record', () => ({
  ...jest.requireActual('./switch-on-record'),
  takeSwitchOnRecord: jest.fn(),
  writeSwitchOnRecordFixture: jest.fn(),
  fetchSwitchOnRecord: jest.fn(),
  loadSwitchOnRecord: jest.fn()
}));
jest.mock('./identity-chain-mirror.service', () => ({
  IdentityChainMirror: jest.fn()
}));
jest.mock('@/rebuild/run/probe-fixture.steps', () => ({
  seedProbeIdentities: jest.fn()
}));
jest.mock('@/chain-gateway/chain-gateway.client', () => ({
  ...jest.requireActual('@/chain-gateway/chain-gateway.client'),
  chainGatewayClient: { getStatus: jest.fn(), getHead: jest.fn() }
}));
jest.mock('./placeholder-restore', () => ({
  ...jest.requireActual('./placeholder-restore'),
  fetchPlaceholdersFile: jest.fn(),
  readPlaceholdersFile: jest.fn(),
  writePlaceholderList: jest.fn(),
  restoreUntakenPlaceholders: jest.fn()
}));
jest.mock('./rebuild-world/placeholder-references', () => ({
  ...jest.requireActual('./rebuild-world/placeholder-references'),
  plantPlaceholderReferences: jest.fn()
}));
jest.mock('./rebuild-world/fixture-file', () => ({
  // The world's file as the steps pin it: its SHA-256.
  worldPlaceholdersFile: () => ({
    bytes: Buffer.from('the world fixture'),
    sha256: 'cd'.repeat(32)
  }),
  writePlaceholdersFixture: jest.fn()
}));
jest.mock('./rebuild-world/site-rows', () => ({
  writeSiteRowsBeforeSwitchOn: jest.fn(),
  writeSiteRowsAfterSwitchOn: jest.fn(),
  writeWavesPeopleTdh: jest.fn()
}));
jest.mock('./identity-chain-mirror.db', () => ({
  ...jest.requireActual('./identity-chain-mirror.db'),
  identityChainMirrorDb: { getState: jest.fn() }
}));

const GATEWAY = 'http://127.0.0.1:4100';
const FILES = 'http://127.0.0.1:4200';
const WITH_FILES = {
  gateway: GATEWAY,
  relays: null,
  ethereum: null,
  files: FILES,
  repo: null
};
const HEIGHT = 40;
const FILE_BYTES = Buffer.from('the placeholders file');
const SEED_FILES = '/run/seed-files';
const WORLD_SHA = 'cd'.repeat(32);
// The switch-on record a seed takes and a rebuild loads: one row, one key.
const RECORD: TdhOnlyRecord = {
  rows: [
    {
      consolidation_key: `0x${'0e'.repeat(20)}`,
      profile_id: '00000000-0000-4000-8000-00000000010e',
      primary_address: `0x${'0e'.repeat(20)}`,
      tdh: 0,
      rep: 0,
      cic: 0,
      level_raw: 0
    }
  ],
  keys: [
    {
      address: `0x${'0e'.repeat(20)}`,
      consolidation_key: `0x${'0e'.repeat(20)}`
    }
  ]
};

function placeholderLine(
  profileId: string,
  wallet: string
): PlaceholderAtFreezeLine {
  return {
    profile_id: profileId,
    wallet,
    handle: `id-${wallet}`,
    normalised_handle: `id-${wallet}`,
    created_at_ms: 1_000,
    created_by_wallet: wallet,
    updated_at_ms: null,
    updated_by_wallet: null,
    pfp_url: null,
    banner_1: null,
    banner_2: null,
    website: null,
    classification: null,
    sub_classification: null,
    identity: null
  };
}
const LINE_A = placeholderLine('p-0a', '0x' + '0a'.repeat(20));
const LINE_B = placeholderLine('p-0b', '0x' + '0b'.repeat(20));

/** The file read as these batches of lines. */
function givesLines(...batches: PlaceholderAtFreezeLine[][]) {
  (readPlaceholdersFile as jest.Mock).mockImplementation(
    async (
      _bytes: Buffer,
      _sha: string,
      onBatch: (lines: PlaceholderAtFreezeLine[]) => Promise<void>
    ) => {
      for (const batch of batches) await onBatch(batch);
      return {
        count: batches.flat().length,
        freeze_ms: 0,
        tdh_block: null,
        exporter_revision: 'test'
      };
    }
  );
}

function ctx(other: Partial<RebuildContext> = {}): RebuildContext {
  return {
    area: 'identity',
    stepId: 'identity.chain-mirror',
    sources: {
      gateway: GATEWAY,
      relays: null,
      ethereum: null,
      files: null,
      repo: null
    },
    seedFilesDir: null,
    mark: { name: 'head', chainHeight: HEIGHT, ethBlock: null },
    final: false,
    ...other
  };
}

function state(other: Partial<MirrorState> = {}): MirrorState {
  return {
    next_height: HEIGHT + 1,
    sync_from_height: null,
    sync_phase: null,
    sync_after: null,
    last_full_sync_at: 1_000,
    bindings_next_height: HEIGHT + 1,
    chain_id: `0x${'ab'.repeat(32)}`,
    placeholders_at: 1_000,
    bindings_exact: true,
    levels_tdh_day: 25,
    level_sweep_day: null,
    level_sweep_after: null,
    levels_day_height: HEIGHT,
    sync_use_case: null,
    sync_wallet_after: null,
    off_chain_after: null,
    pin_floor: HEIGHT,
    events_next_height: HEIGHT + 1,
    events_rebuild_height: null,
    events_rebuild_after: null,
    events_gone_at: null,
    events_stuck_runs: 0,
    retry: NO_RETRY,
    ...other
  };
}

function report(other: Partial<MirrorRunReport> = {}): MirrorRunReport {
  return {
    mode: 'full_sync',
    identities: 4,
    ratingTargets: 4,
    delegationWallets: 3,
    feedBlocks: 0,
    skippedTooManyWallets: [],
    skippedInactive: [],
    failed: [],
    retryLeft: 0,
    regroupedWallets: [],
    orphanedProfiles: [],
    handlelessNotAdopted: [],
    walletBindings: 5,
    bindingProblems: [],
    bindingsNextHeight: HEIGHT + 1,
    docProblems: [],
    nextHeight: HEIGHT + 1,
    levelsSwept: 0,
    levelSweepDay: null,
    deferred: 0,
    ratingEvents: 8,
    ratingEventProblems: [],
    ratingEventProblemsLeftOut: 0,
    ratingRecordsWithoutWriter: 0,
    eventsNextHeight: HEIGHT + 1,
    ratingEventsFilled: 0,
    ...other
  };
}

/** A mirror whose runs give these reports and leave these states. */
function setUp(
  runs: { report: MirrorRunReport; state: MirrorState | null }[],
  queued: string[][] = []
) {
  let at = 0;
  const run = jest.fn(async () => runs[Math.min(at++, runs.length - 1)].report);
  const queue = [...queued];
  const mirror = {
    run,
    pendingRegroups: jest.fn(async () => queue.shift() ?? []),
    regroupsStarted: jest.fn(async () => undefined),
    regroupsDone: jest.fn(async () => undefined)
  };
  (IdentityChainMirror as unknown as jest.Mock).mockImplementation(
    () => mirror
  );
  const db = {
    getState: jest.fn(
      async () => runs[Math.min(at - 1, runs.length - 1)]?.state ?? null
    )
  };
  const gateway = {
    getStatus: jest.fn(async () => ({ import: { completed: true } })),
    getHead: jest.fn(async () => ({ finalizedHeight: HEIGHT }))
  };
  const deps: MirrorToMarkDeps = {
    gateway: gateway as never,
    db: db as unknown as IdentityChainMirrorDb,
    now: () => 0,
    env: { CHAIN_GATEWAY_URL: `${GATEWAY}/` },
    mirrorEnabled: () => true,
    budgetMs: 60_000,
    maxRuns: 3
  };
  return { run, mirror, db, gateway, deps };
}

describe('caughtUp', () => {
  it('holds once a full sync ended and every cursor is past the height', () => {
    expect(caughtUp(state(), HEIGHT)).toBe(true);
  });

  it.each([
    ['no state', null],
    ['a full sync under way', state({ sync_phase: 'DELEGATIONS' })],
    ['no full sync ended', state({ last_full_sync_at: null })],
    ['the bindings behind', state({ bindings_next_height: HEIGHT })],
    ['the rating events behind', state({ events_next_height: 5 })],
    ['a ledger rebuild under way', state({ events_rebuild_height: HEIGHT })],
    ['a level sweep under way', state({ level_sweep_day: 25 })],
    [
      'keys to try again',
      state({ retry: { principals: ['0x01'], targets: [], wallets: [] } })
    ]
  ])('does not hold with %s', (_name, given) => {
    expect(caughtUp(given, HEIGHT)).toBe(false);
  });
});

describe('mirrorToMark', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the mirror without membership handlers until it has caught up', async () => {
    const { run, deps } = setUp([
      { report: report(), state: state({ sync_phase: 'DELEGATIONS' }) },
      { report: report(), state: state() }
    ]);
    const result = await mirrorToMark(ctx(), deps);
    expect(result).toMatchObject({ height: HEIGHT, runs: 2 });
    expect(run).toHaveBeenCalledWith({ budgetMs: 60_000 });
    const args = (IdentityChainMirror as unknown as jest.Mock).mock.calls[0];
    expect(args[0]).toBe(deps.gateway);
    expect(args[1]).toBe(deps.db);
    expect(args[3]).toEqual([]);
  });

  it('takes the regrouped wallets off the queue at the end, as the delegations loop does', async () => {
    const { mirror, deps } = setUp(
      [{ report: report(), state: state() }],
      [['0x03', '0x04'], ['0x05']]
    );
    const result = await mirrorToMark(ctx(), deps);
    expect(result.regroupsDrained).toBe(3);
    expect(mirror.regroupsStarted).toHaveBeenCalledWith(['0x03', '0x04']);
    expect(mirror.regroupsDone).toHaveBeenCalledWith(['0x03', '0x04'], 0);
    expect(mirror.regroupsDone).toHaveBeenCalledWith(['0x05'], 0);
    expect(mirror.pendingRegroups).toHaveBeenCalledTimes(3);
  });

  it('fails when a batch of regrouped wallets stays queued', async () => {
    const { deps } = setUp(
      [{ report: report(), state: state() }],
      [['0x03'], ['0x03']]
    );
    await expect(mirrorToMark(ctx(), deps)).rejects.toThrow(
      /stay queued after they were taken off: 0x03/
    );
  });

  it("keeps its runs within the steps' timeout", () => {
    const mirrorSteps = [
      ...identityManifest.seeds,
      ...identityManifest.rebuilders
    ].filter(
      (step) =>
        'module' in step.run &&
        step.run.module.endsWith('identity-chain-mirror.rebuild') &&
        ['seedIdentityMirror', 'rebuildIdentityMirror'].includes(
          step.run.exportName
        )
    );
    expect(mirrorSteps).toHaveLength(2);
    for (const step of mirrorSteps) {
      expect(MIRROR_RUNS_AT_MOST_MS).toBeLessThan(step.timeoutMinutes * 60_000);
    }
  });

  it('takes the source height when the run names no mark', async () => {
    const { deps } = setUp([{ report: report(), state: state() }]);
    const result = await mirrorToMark(
      ctx({ mark: { name: 'head', chainHeight: null, ethBlock: null } }),
      deps
    );
    expect(result.height).toBe(HEIGHT);
  });

  it('refuses a run without a gateway source', async () => {
    const { deps, run } = setUp([{ report: report(), state: state() }]);
    await expect(
      mirrorToMark(
        ctx({
          sources: {
            gateway: null,
            relays: null,
            ethereum: null,
            files: null,
            repo: null
          }
        }),
        deps
      )
    ).rejects.toThrow(/--source gateway/);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a gateway setting other than the source', async () => {
    const { deps } = setUp([{ report: report(), state: state() }]);
    await expect(
      mirrorToMark(ctx(), {
        ...deps,
        env: { CHAIN_GATEWAY_URL: 'http://127.0.0.1:9999' }
      })
    ).rejects.toThrow(/CHAIN_GATEWAY_URL/);
  });

  it('refuses when the mirror is off', async () => {
    const { deps } = setUp([{ report: report(), state: state() }]);
    await expect(
      mirrorToMark(ctx(), { ...deps, mirrorEnabled: () => false })
    ).rejects.toThrow(/FEATURE_IDENTITY_CHAIN_MIRROR/);
  });

  it('refuses a chain with no identity import', async () => {
    const { deps, gateway } = setUp([{ report: report(), state: state() }]);
    gateway.getStatus.mockResolvedValue({} as never);
    await expect(mirrorToMark(ctx(), deps)).rejects.toThrow(
      /no identity import/
    );
  });

  it('refuses a source that is not at the mark', async () => {
    const { deps, run } = setUp([{ report: report(), state: state() }]);
    await expect(
      mirrorToMark(
        ctx({ mark: { name: 'head', chainHeight: 39, ethBlock: null } }),
        deps
      )
    ).rejects.toThrow(/not the mark 39/);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails on a run that stopped, skipped or is stuck', async () => {
    for (const bad of [
      report({ error: 'gone' }),
      report({ skipped: 'import_not_complete' }),
      report({ ratingEventsStuck: 'stuck for five runs' })
    ]) {
      const { deps } = setUp([{ report: bad, state: state() }]);
      await expect(mirrorToMark(ctx(), deps)).rejects.toThrow();
    }
  });

  it('fails when identities failed or it never catches up', async () => {
    const failed = setUp([
      { report: report({ failed: ['0x11: no'] }), state: state() }
    ]);
    await expect(mirrorToMark(ctx(), failed.deps)).rejects.toThrow(
      /after 3 runs/
    );
    expect(failed.run).toHaveBeenCalledTimes(3);
  });

  it('fails when the source moved on during the rebuild', async () => {
    const { deps, gateway } = setUp([{ report: report(), state: state() }]);
    gateway.getHead
      .mockResolvedValueOnce({ finalizedHeight: HEIGHT })
      .mockResolvedValueOnce({ finalizedHeight: HEIGHT + 3 });
    await expect(mirrorToMark(ctx(), deps)).rejects.toThrow(/moved from 40/);
  });
});

describe('seedIdentityMirror', () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes the probe fixture's rows when the run has no gateway", async () => {
    await seedIdentityMirror(
      ctx({
        sources: {
          gateway: null,
          relays: null,
          ethereum: null,
          files: null,
          repo: null
        }
      })
    );
    expect(seedProbeIdentities).toHaveBeenCalledTimes(1);
    expect(IdentityChainMirror).not.toHaveBeenCalled();
  });

  it("writes them when the gateway's chain has no identity import", async () => {
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({});
    await seedIdentityMirror(ctx());
    expect(seedProbeIdentities).toHaveBeenCalledTimes(1);
    expect(IdentityChainMirror).not.toHaveBeenCalled();
    expect(writeSiteRowsBeforeSwitchOn).not.toHaveBeenCalled();
  });

  it("writes 6529.io's rows before the mirror's run and after it", async () => {
    const order: string[] = [];
    const placeholders = [LINE_A, LINE_B];
    (fetchPlaceholdersFile as jest.Mock).mockResolvedValue(FILE_BYTES);
    givesLines([LINE_A], [LINE_B]);
    (writePlaceholdersFixture as jest.Mock).mockImplementation(() =>
      order.push('fixture')
    );
    (writeSiteRowsBeforeSwitchOn as jest.Mock).mockImplementation(
      async (given: unknown) => {
        expect(given).toEqual(placeholders);
        order.push('before');
      }
    );
    (writeSiteRowsAfterSwitchOn as jest.Mock).mockImplementation(async () =>
      order.push('after')
    );
    (writeWavesPeopleTdh as jest.Mock).mockImplementation(async () => {
      order.push('waves people');
      return 0;
    });
    (takeSwitchOnRecord as jest.Mock).mockImplementation(async () => {
      order.push('record taken');
      return RECORD;
    });
    (writeSwitchOnRecordFixture as jest.Mock).mockImplementation(
      (_dir: string, formatted: FormattedTdhOnlyRecord) => ({
        identitiesSha256: formatted.identitiesSha256,
        keysSha256: formatted.keysSha256
      })
    );
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({
      import: { completed: true }
    });
    (chainGatewayClient.getHead as jest.Mock).mockResolvedValue({
      finalizedHeight: HEIGHT
    });
    (identityChainMirrorDb.getState as jest.Mock).mockResolvedValue(state());
    const { run } = setUp([{ report: report(), state: state() }]);
    run.mockImplementation(async () => {
      order.push('mirror');
      return report();
    });
    const saved = { ...process.env };
    process.env.CHAIN_GATEWAY_URL = GATEWAY;
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    try {
      await seedIdentityMirror(
        ctx({ sources: WITH_FILES, seedFilesDir: SEED_FILES })
      );
    } finally {
      process.env = saved;
    }
    // The record is taken where the team takes it: after 6529.io's last
    // writes before switch-on, right before the mirror's first run.
    expect(order).toEqual([
      'fixture',
      'before',
      'record taken',
      'mirror',
      'after',
      'waves people'
    ]);
    expect(writeSwitchOnRecordFixture).toHaveBeenCalledWith(
      SEED_FILES,
      formatTdhOnlyRecord(RECORD.rows, RECORD.keys)
    );
    expect(writePlaceholdersFixture).toHaveBeenCalledWith(SEED_FILES);
    expect(fetchPlaceholdersFile).toHaveBeenCalledWith(expect.anything(), {
      sha256: WORLD_SHA,
      fixture: true
    });
    expect(seedProbeIdentities).not.toHaveBeenCalled();
  });
});

describe('rebuildIdentityMirror', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchSwitchOnRecord as jest.Mock).mockResolvedValue({
      record: RECORD,
      fixture: true
    });
    (loadSwitchOnRecord as jest.Mock).mockResolvedValue({
      identities: 1,
      keys: 1
    });
  });

  it('loads the switch-on record, lists the placeholders, runs the mirror, then restores the untaken ones', async () => {
    const order: string[] = [];
    (fetchSwitchOnRecord as jest.Mock).mockResolvedValue({
      record: RECORD,
      fixture: true
    });
    (loadSwitchOnRecord as jest.Mock).mockImplementation(
      async (record: TdhOnlyRecord) => {
        expect(record).toBe(RECORD);
        order.push('record loaded');
        return { identities: 1, keys: 1 };
      }
    );
    (fetchPlaceholdersFile as jest.Mock).mockResolvedValue(FILE_BYTES);
    givesLines([LINE_A], [LINE_B]);
    (writePlaceholderList as jest.Mock).mockImplementation(
      async (lines: PlaceholderAtFreezeLine[]) => {
        order.push(`list ${lines.map((it) => it.profile_id).join()}`);
      }
    );
    (restoreUntakenPlaceholders as jest.Mock).mockImplementation(async () => {
      order.push('restore');
      return {
        taken: 1,
        profiles: 1,
        identities: 1,
        rekeyed: 0,
        withoutIdentity: 0
      };
    });
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({
      import: { completed: true }
    });
    (chainGatewayClient.getHead as jest.Mock).mockResolvedValue({
      finalizedHeight: HEIGHT
    });
    (identityChainMirrorDb.getState as jest.Mock).mockResolvedValue(state());
    const { run } = setUp([{ report: report(), state: state() }]);
    run.mockImplementation(async () => {
      order.push('mirror');
      return report();
    });
    const saved = { ...process.env };
    process.env.CHAIN_GATEWAY_URL = GATEWAY;
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    try {
      await rebuildIdentityMirror(ctx({ sources: WITH_FILES }));
    } finally {
      process.env = saved;
    }
    // The record's rows are in before the mirror's run, so it adopts their
    // ids again on equal keys.
    expect(order).toEqual([
      'record loaded',
      'list p-0a',
      'list p-0b',
      'mirror',
      'restore'
    ]);
    expect(readPlaceholdersFile).toHaveBeenCalledWith(
      FILE_BYTES,
      WORLD_SHA,
      expect.any(Function)
    );
    expect(restoreUntakenPlaceholders).toHaveBeenCalledWith(
      FILE_BYTES,
      WORLD_SHA
    );
  });

  it('restores nothing when the mirror fails', async () => {
    (fetchPlaceholdersFile as jest.Mock).mockResolvedValue(FILE_BYTES);
    givesLines([LINE_A]);
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({});
    const saved = { ...process.env };
    process.env.CHAIN_GATEWAY_URL = GATEWAY;
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    try {
      await expect(
        rebuildIdentityMirror(ctx({ sources: WITH_FILES }))
      ).rejects.toThrow(/no identity import/);
    } finally {
      process.env = saved;
    }
    expect(restoreUntakenPlaceholders).not.toHaveBeenCalled();
  });
});

describe('the fixture on a final run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The real read, which refuses the fixture before fetching it.
    (fetchPlaceholdersFile as jest.Mock).mockImplementation(
      jest.requireActual('./placeholder-restore').fetchPlaceholdersFile
    );
    // The real read, which refuses the world's take before fetching it.
    (fetchSwitchOnRecord as jest.Mock).mockImplementation(
      jest.requireActual('./switch-on-record').fetchSwitchOnRecord
    );
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({
      import: { completed: true }
    });
  });
  // clearAllMocks keeps an implementation: the real reads stay here.
  afterEach(() => {
    (fetchPlaceholdersFile as jest.Mock).mockReset();
    (fetchSwitchOnRecord as jest.Mock).mockReset();
  });

  it('stops the seed before it writes anything', async () => {
    await expect(
      seedIdentityMirror(ctx({ sources: WITH_FILES, final: true }))
    ).rejects.toThrow(/fixture, not the freeze's/);
    expect(writePlaceholdersFixture).not.toHaveBeenCalled();
    expect(writeSiteRowsBeforeSwitchOn).not.toHaveBeenCalled();
    expect(takeSwitchOnRecord).not.toHaveBeenCalled();
    expect(writeSwitchOnRecordFixture).not.toHaveBeenCalled();
    expect(IdentityChainMirror).not.toHaveBeenCalled();
  });

  it('stops the rebuilder before it loads a row or lists a placeholder', async () => {
    await expect(
      rebuildIdentityMirror(ctx({ sources: WITH_FILES, final: true }))
    ).rejects.toThrow(/not pinned yet; a final run reads the team's take/);
    expect(loadSwitchOnRecord).not.toHaveBeenCalled();
    expect(writePlaceholderList).not.toHaveBeenCalled();
    expect(IdentityChainMirror).not.toHaveBeenCalled();
    expect(restoreUntakenPlaceholders).not.toHaveBeenCalled();
  });
});

describe('seedPlaceholderReferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('plants them with the identity world', async () => {
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({
      import: { completed: true }
    });
    await seedPlaceholderReferences(ctx({ sources: WITH_FILES }));
    expect(plantPlaceholderReferences).toHaveBeenCalledTimes(1);
  });

  it('plants none without it', async () => {
    (chainGatewayClient.getStatus as jest.Mock).mockResolvedValue({});
    await seedPlaceholderReferences(ctx({ sources: WITH_FILES }));
    expect(plantPlaceholderReferences).not.toHaveBeenCalled();
  });
});

describe('docsFromFiles', () => {
  const doc = Buffer.from('{"fields":{"bio":"a document"}}');
  const cid = `0x01551220${createHash('sha256').update(doc).digest('hex')}`;
  const name = cidPath(cid);
  const gateway = {
    calls: 0,
    getStatus() {
      this.calls++;
      return Promise.resolve({ import: {} });
    },
    getProfileDoc: () => Promise.reject(new Error('the gateway was asked'))
  };
  const answer = (status: number, body: Buffer) =>
    ({
      status,
      arrayBuffer: async () => Uint8Array.from(body).buffer
    }) as unknown as Response;

  it('reads a document from the files source by its CID name', async () => {
    const fetchImpl = jest.fn(async () => answer(200, doc));
    const wrapped = docsFromFiles(
      gateway as never,
      `${FILES}/`,
      fetchImpl as never
    );
    const bytes = await (
      wrapped as never as { getProfileDoc(c: string): Promise<Buffer> }
    ).getProfileDoc(cid);
    expect(bytes.equals(doc)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(`${FILES}/${name}`);
  });

  it('reads none for a file the source lacks, and refuses bytes of another CID', async () => {
    const missing = docsFromFiles(gateway as never, FILES, (async () =>
      answer(404, Buffer.alloc(0))) as never) as never as {
      getDocument(c: string): Promise<Buffer | null>;
    };
    expect(await missing.getDocument(cid)).toBeNull();
    const wrong = docsFromFiles(gateway as never, FILES, (async () =>
      answer(200, Buffer.from('other bytes'))) as never) as never as {
      getProfileDoc(c: string): Promise<Buffer>;
    };
    await expect(wrong.getProfileDoc(cid)).rejects.toMatchObject({
      code: 'cid_mismatch'
    });
  });

  it('leaves every other read to the gateway', async () => {
    const wrapped = docsFromFiles(
      gateway as never,
      FILES,
      jest.fn() as never
    ) as never as {
      getStatus(): Promise<unknown>;
    };
    await expect(wrapped.getStatus()).resolves.toEqual({ import: {} });
    expect(gateway.calls).toBe(1);
  });
});
