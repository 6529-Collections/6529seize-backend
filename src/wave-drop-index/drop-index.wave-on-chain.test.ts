import { DeviceEventKind } from '@/api/device-signing/device-event';
import { DbPoolName } from '@/db-query.options';
import {
  TEST_GRANT_ID,
  TEST_WALLET,
  testGrantProof,
  testSignedEvent
} from '@/tests/fixtures/relay-events.fixture';
import { READ_THROUGH_MARGIN_MS } from '@/waves-chain-index/waves-chain-mapping';
import { DropIndexDb, IngestedEvent } from './drop-index.db';
import {
  INDEX_BEHIND_REASON,
  NOT_ON_SITE_REASON,
  RelayApplyStore,
  RelayDropApplier,
  RelayDropWrites,
  STAYS_ON_SITE_REASON
} from './relay-drop-applier';

const MINUTE = 60_000;
const NET = `0x${'ab'.repeat(32)}`;
const T0 = Date.UTC(2026, 10, 27, 12);

/**
 * A database with the tables DropIndexDb.waveOnChain reads, answering as
 * MySQL would: 6529.io's waves, the chain index's state row and its waves.
 */
class FakeTables {
  siteWaves = new Map<string, { is_direct_message: boolean }>();
  state: Record<string, unknown> | null = null;
  chainWaves: { wave_id: string; legacy_id: string | null; origin: string }[] =
    [];
  stateTableMissing = false;
  readonly options: unknown[] = [];

  executor() {
    const execute = async (
      sql: string,
      params: Record<string, any> = {},
      options?: unknown
    ) => {
      this.options.push(options);
      if (sql.includes('from waves_chain_index_state')) {
        if (this.stateTableMissing) {
          throw Object.assign(new Error('no such table'), {
            code: 'ER_NO_SUCH_TABLE'
          });
        }
        return this.state ? [this.state] : [];
      }
      if (sql.includes('from chain_waves')) {
        const ids: string[] = params.ids;
        return this.chainWaves.filter(
          (row) =>
            (row.legacy_id !== null &&
              ids.includes(row.legacy_id) &&
              row.origin === 'legacy') ||
            (ids.includes(row.wave_id) && row.origin === 'native')
        );
      }
      if (sql.includes('as dm from waves')) {
        const wave = this.siteWaves.get(params.id);
        return wave ? [{ dm: wave.is_direct_message ? 1 : 0 }] : [];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    return () =>
      ({
        execute,
        oneOrNull: async (sql: string, params?: any, options?: unknown) =>
          (await execute(sql, params, options))[0] ?? null
      }) as any;
  }
}

/** The state row of an index that caught up with its read at `savedAt`. */
function caughtUp(savedAt: number, fields: Record<string, unknown> = {}) {
  return {
    last_full_at: String(T0 - 24 * 60 * MINUTE),
    network: NET,
    last_error: null,
    feed_next: '501',
    read_height: '500',
    feed_part: 0,
    full_phase: null,
    updated_at: String(savedAt),
    ...fields
  };
}

describe('DropIndexDb.waveOnChain', () => {
  let tables: FakeTables;
  let db: DropIndexDb;
  const original = process.env.WAVES_SETTLEMENT_NETWORK_ID;

  beforeEach(() => {
    tables = new FakeTables();
    db = new DropIndexDb(tables.executor());
    process.env.WAVES_SETTLEMENT_NETWORK_ID = NET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.WAVES_SETTLEMENT_NETWORK_ID;
    else process.env.WAVES_SETTLEMENT_NETWORK_ID = original;
  });

  it('is unknown while the index has no full read, its tables are missing, or it is on another network', async () => {
    tables.siteWaves.set('wave-1', { is_direct_message: false });
    tables.chainWaves = [
      { wave_id: `0x${'11'.repeat(32)}`, legacy_id: 'wave-1', origin: 'legacy' }
    ];
    expect(await db.waveOnChain('wave-1', T0)).toBe('unknown');
    tables.state = caughtUp(T0, { last_full_at: null });
    expect(await db.waveOnChain('wave-1', T0)).toBe('unknown');
    tables.state = caughtUp(T0, { network: `0x${'cd'.repeat(32)}` });
    expect(await db.waveOnChain('wave-1', T0)).toBe('unknown');
    tables.stateTableMissing = true;
    expect(await db.waveOnChain('wave-1', T0)).toBe('unknown');
    // Every read on the writer.
    expect(new Set(tables.options.map((o) => JSON.stringify(o)))).toEqual(
      new Set([JSON.stringify({ forcePool: DbPoolName.WRITE })])
    );
  });

  it('is moved for an imported wave the chain holds, asked in any case', async () => {
    tables.state = caughtUp(T0);
    tables.siteWaves.set('wave-1', { is_direct_message: false });
    tables.chainWaves = [
      { wave_id: `0x${'11'.repeat(32)}`, legacy_id: 'wave-1', origin: 'legacy' }
    ];
    expect(await db.waveOnChain(' WAVE-1 ', T0)).toBe('moved');
  });

  it('is not_on_site for a wave the chain holds that 6529.io has no row of yet', async () => {
    const made = `0x${'22'.repeat(32)}`;
    tables.state = caughtUp(T0);
    tables.chainWaves = [{ wave_id: made, legacy_id: null, origin: 'native' }];
    expect(await db.waveOnChain(made, T0)).toBe('not_on_site');
    tables.siteWaves.set(made, { is_direct_message: false });
    expect(await db.waveOnChain(made, T0)).toBe('moved');
  });

  it('is a direct message whatever the chain says', async () => {
    tables.state = caughtUp(T0);
    tables.siteWaves.set('dm', { is_direct_message: true });
    tables.chainWaves = [
      { wave_id: `0x${'33'.repeat(32)}`, legacy_id: 'dm', origin: 'legacy' }
    ];
    expect(await db.waveOnChain('dm', T0)).toBe('direct_message');
  });

  it('stays only once the index has read past the event; behind until then', async () => {
    tables.siteWaves.set('site-wave', { is_direct_message: false });
    // A chain-made row that carries the site wave's id as a legacy id: not it.
    tables.chainWaves = [
      {
        wave_id: `0x${'44'.repeat(32)}`,
        legacy_id: 'site-wave',
        origin: 'native'
      }
    ];
    const seenAt = T0;
    tables.state = caughtUp(seenAt + READ_THROUGH_MARGIN_MS - 1);
    expect(await db.waveOnChain('site-wave', seenAt)).toBe('behind');
    tables.state = caughtUp(seenAt + READ_THROUGH_MARGIN_MS);
    expect(await db.waveOnChain('site-wave', seenAt)).toBe('stays');
    // Saved late, but behind its own read, failing, or in a full read's waves.
    for (const fields of [
      { feed_next: '500' },
      { last_error: 'gateway down' },
      { full_phase: 'waves' }
    ]) {
      tables.state = caughtUp(seenAt + 60 * MINUTE, fields);
      expect(await db.waveOnChain('site-wave', seenAt)).toBe('behind');
    }
  });
});

describe('an index stall of 90 minutes loses no event of a wave made on the chain', () => {
  const made = `0x${'55'.repeat(32)}`;

  function aPost(): IngestedEvent {
    const event = testSignedEvent({
      kind: DeviceEventKind.POST,
      body: {
        wave_id: made,
        drop_type: 'CHAT',
        parts: [{ content: 'gm', media: [] }]
      },
      refs: [],
      seq: 1,
      wave: made
    });
    return {
      ingest_seq: 1,
      event_id: String(event.id),
      relay_id: 'r-1',
      wave: made,
      wave_key: null,
      drop_id: null,
      kind: DeviceEventKind.POST,
      author: TEST_WALLET,
      device_key: String(event.device_key),
      auth_ref: TEST_GRANT_ID,
      seq: 1,
      claimed_time: T0 - 1000,
      event,
      grant_proof: testGrantProof(),
      origin: 'relay',
      event_origin: 'OPERATION',
      status: 'logged',
      status_reason: null,
      grant_check: 'signature',
      grant_revoked_at: null,
      received_at: T0,
      apply_attempts: 0
    };
  }

  function aStore(db: DropIndexDb, event: IngestedEvent) {
    const marks: [string, string | null][] = [];
    const store: RelayApplyStore = {
      waveOnChain: (wave, seenAt) => db.waveOnChain(wave, seenAt),
      pendingRelayEvents: async () => [event],
      hasTombstone: async () => false,
      hasPendingReservation: async () => false,
      releaseStaleReservation: async () => undefined,
      markApplied: async (_seq, status, reason) => {
        marks.push([status, reason]);
      }
    };
    return { store, marks };
  }

  function aWrites() {
    const created: string[] = [];
    const writes: RelayDropWrites = {
      profileIdOfWallet: async () => 'profile-1',
      ensureGrant: async () => undefined,
      createDrop: async (_input, dropId) => {
        created.push(dropId);
        return dropId;
      },
      updateDrop: async () => undefined,
      deleteDrop: async () => undefined,
      react: async () => undefined
    };
    return { writes, created };
  }

  const original = process.env.WAVES_SETTLEMENT_NETWORK_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.WAVES_SETTLEMENT_NETWORK_ID;
    else process.env.WAVES_SETTLEMENT_NETWORK_ID = original;
  });

  it('waits through the stall and the mirror, then writes the post', async () => {
    delete process.env.WAVES_SETTLEMENT_NETWORK_ID;
    const tables = new FakeTables();
    const db = new DropIndexDb(tables.executor());
    const event = aPost();
    const { writes, created } = aWrites();
    // The index last caught up five minutes before the post was first seen,
    // then stalled; the wave was made on the chain a minute before the post.
    tables.state = caughtUp(T0 - 5 * MINUTE);
    const at = async (minutes: number) => {
      const { store, marks } = aStore(db, event);
      await new RelayDropApplier(
        store,
        writes,
        () => T0 + minutes * MINUTE,
        null
      ).applyPending({ limit: 10, deadline: Number.MAX_SAFE_INTEGER });
      return marks;
    };
    expect(await at(90)).toEqual([['waiting', INDEX_BEHIND_REASON]]);
    // The index catches up and holds the wave; the mirror hasn't written it.
    tables.state = caughtUp(T0 + 91 * MINUTE);
    tables.chainWaves = [{ wave_id: made, legacy_id: null, origin: 'native' }];
    expect(await at(92)).toEqual([['waiting', NOT_ON_SITE_REASON]]);
    tables.siteWaves.set(made, { is_direct_message: false });
    expect(await at(93)).toEqual([['applied', null]]);
    expect(created).toHaveLength(1);
  });

  it('refuses the post once the index has read past it without the wave', async () => {
    delete process.env.WAVES_SETTLEMENT_NETWORK_ID;
    const tables = new FakeTables();
    const db = new DropIndexDb(tables.executor());
    const event = aPost();
    const { writes, created } = aWrites();
    tables.state = caughtUp(T0 + 91 * MINUTE);
    const { store, marks } = aStore(db, event);
    await new RelayDropApplier(
      store,
      writes,
      () => T0 + 92 * MINUTE,
      null
    ).applyPending({ limit: 10, deadline: Number.MAX_SAFE_INTEGER });
    expect(marks).toEqual([['refused', STAYS_ON_SITE_REASON]]);
    expect(created).toEqual([]);
  });
});
