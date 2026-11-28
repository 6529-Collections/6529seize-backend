import { COMPETITIONS_TABLE, WAVE_CURATIONS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { WaveEntity } from '@/entities/IWave';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  CHAIN_INDEX_STATE_ROW,
  CHAIN_INDEX_STATE_TABLE_NAME,
  CHAIN_NETWORK_ID_ENV,
  CHAIN_WAVES_TABLE_NAME,
  IMPORTED_ORIGIN,
  NATIVE_ORIGIN,
  waveOnChainSql
} from '@/waves-chain-index/waves-chain-mapping';
import { WAVES_FREEZE_AT_ENV } from '@/waves-freeze/waves-freeze';
import {
  ChainState,
  ChainStateSql,
  RECORDS_WAVE_ID_ENV,
  scopeFromRow,
  ScopeWave,
  StayReason,
  staysOnSite,
  wavesScopeSql
} from '@/waves-scope/waves-scope';
import { WavesScopeService } from '@/waves-scope/waves-scope.service';

const FREEZE = Date.UTC(2026, 10, 25);
const AFTER = FREEZE + 60_000;

const group = (
  id: string,
  props: Partial<Omit<UserGroupEntity, 'id' | 'name'>> = {}
) =>
  aUserGroup(
    { visible: true, is_private: false, is_direct_message: false, ...props },
    { id, name: id }
  );

const GROUPS = [
  group('public'),
  group('shared'),
  group('members'),
  group('hidden', { visible: false }),
  group('private', { is_private: true }),
  group('dm-group', { is_direct_message: true }),
  group('late-group', { created_at: new Date(AFTER) }),
  // Used only by a staying subwave, and only by a moving one.
  group('sub-group'),
  group('sub-moving-group')
];

const wave = (id: string, props: Partial<WaveEntity> = {}) =>
  aWave(props, { id, name: id });

const CHAIN_MADE = '0x' + 'cd'.repeat(32);
/** The network the test's chain index has read. */
const NETWORK = '0x' + 'ee'.repeat(32);

const WAVES = [
  wave('moving', {
    admin_group_id: 'public',
    chat_group_id: 'shared',
    participation_group_id: 'public',
    voting_group_id: 'public'
  }),
  wave('dm', { is_direct_message: true }),
  wave('records'),
  wave('members-only', {
    visibility_group_id: 'members',
    chat_group_id: 'shared'
  }),
  wave('admin-hidden', { admin_group_id: 'hidden' }),
  wave('chat-private', { chat_group_id: 'private' }),
  wave('dm-group-user', { chat_group_id: 'dm-group' }),
  wave('hub-submit-hidden', { participation_group_id: 'hidden' }),
  wave('hub-vote-private', { voting_group_id: 'private' }),
  wave('curation-hidden'),
  wave('decision-submit-hidden'),
  wave('decision-hub'),
  wave('decision-legacy'),
  // A group id with no community_groups row stays.
  wave('missing-group', { admin_group_id: 'no-such-group' }),
  wave('late-group-user', { admin_group_id: 'late-group' }),
  wave('chat-off', { chat_enabled: false }),
  wave('chat-off-admin', { chat_enabled: false, admin_group_id: 'public' }),
  wave('late-wave', { created_at: AFTER }),
  // A tree under a members-only wave, two levels deep, stays whole.
  wave('subwave', {
    parent_wave_id: 'members-only',
    admin_group_id: 'public',
    chat_group_id: 'sub-group'
  }),
  wave('sub-subwave', { parent_wave_id: 'subwave' }),
  // A tree under a wave with a hidden group stays too.
  wave('sub-of-hidden', { parent_wave_id: 'chat-private' }),
  // A subwave whose parent has no row stays, and so does a wave under it.
  wave('orphan', { parent_wave_id: 'no-such-wave' }),
  wave('under-orphan', { parent_wave_id: 'orphan' }),
  // A public subwave of a moving wave moves.
  wave('sub-of-moving', {
    parent_wave_id: 'moving',
    chat_group_id: 'sub-moving-group'
  }),
  // A wave that names itself as its parent is not its own ancestor.
  wave('self-parent', {
    parent_wave_id: 'self-parent',
    admin_group_id: 'hidden'
  }),
  // A wave made on the chain keeps its chain id.
  wave(CHAIN_MADE)
];

const CURATIONS = [
  ['curation-hidden', 'public'],
  ['curation-hidden', 'hidden'],
  ['moving', 'public']
].map(([wave_id, community_group_id], index) => ({
  id: `curation-${index}`,
  name: `curation ${index}`,
  wave_id,
  community_group_id,
  created_at: 1,
  updated_at: 1,
  priority_order: null
}));

function decision(
  id: string,
  waveId: string,
  legacyWaveId: string | null,
  participationGroup: string | null,
  votingGroup: string | null
) {
  const record = nativeOriginalPrimaryFixture(
    WAVES.find((it) => it.id === waveId)!
  );
  return {
    ...record,
    id,
    wave_id: waveId,
    legacy_wave_id: legacyWaveId,
    participation_config: {
      ...record.participation_config,
      group_id: participationGroup
    },
    voting_config: { ...record.voting_config, group_id: votingGroup }
  };
}

const DECISIONS = [
  decision('d-submit', 'decision-submit-hidden', null, 'hidden', 'public'),
  // A migrated decision: on its hub wave, naming its legacy wave.
  decision('d-legacy', 'decision-hub', 'decision-legacy', 'public', 'private'),
  // A JSON null group is no group.
  decision('d-moving', 'moving', null, null, 'shared')
];

/** What the chain holds after the switch-on, in these tests. */
const HELD = new Set(['moving', 'members-only', 'dm', CHAIN_MADE]);

/** The TypeScript form's view of the seeded rows. */
function scopeWave(
  entity: WaveEntity,
  seen: ReadonlySet<string> | null = new Set<string>()
): ScopeWave {
  const parent = WAVES.find((it) => it.id === entity.parent_wave_id);
  const below = new Set(seen ?? []).add(entity.id);
  return {
    id: entity.id,
    is_direct_message: entity.is_direct_message,
    visibility_group_id: entity.visibility_group_id,
    admin_group_id: entity.admin_group_id,
    chat_group_id: entity.chat_group_id,
    hub_group_ids: [entity.participation_group_id, entity.voting_group_id],
    curation_group_ids: CURATIONS.filter((it) => it.wave_id === entity.id).map(
      (it) => it.community_group_id
    ),
    decision_group_ids: DECISIONS.filter(
      (it) => it.wave_id === entity.id || it.legacy_wave_id === entity.id
    ).flatMap((it) => [
      it.participation_config.group_id,
      it.voting_config.group_id
    ]),
    chat_enabled: entity.chat_enabled,
    created_at: Number(entity.created_at),
    parent_wave_id: entity.parent_wave_id,
    // A parent already on the way down (a loop) ends the walk there: it is
    // read without parents of its own (seen null).
    parent:
      !parent || seen === null
        ? null
        : scopeWave(parent, below.has(parent.id) ? null : below)
  };
}

const GROUPS_BY_ID = new Map(
  GROUPS.map((it) => [
    it.id,
    {
      visible: it.visible,
      is_private: it.is_private,
      is_direct_message: it.is_direct_message,
      created_at: it.created_at.getTime()
    }
  ])
);

const PARAMS = { freezeAtMs: FREEZE, freezeAt: new Date(FREEZE) };

async function sqlScopes(recordsWaveId: string | null, chain: ChainStateSql) {
  const sql = wavesScopeSql('w', chain);
  // Kept under RDS Proxy's 16,000 bytes, past which a session is pinned.
  expect(Buffer.byteLength(sql.select)).toBeLessThan(16_000);
  const rows = await sqlExecutor.execute<
    { id: string } & Record<string, unknown>
  >(
    `${sql.select} order by w.id`,
    { ...PARAMS, recordsWaveId },
    { forcePool: DbPoolName.WRITE }
  );
  // The `stays` condition picks the same waves.
  const staying = await sqlExecutor.execute<{ id: string }>(
    `select w.id from waves w where ${sql.stays}`,
    { ...PARAMS, recordsWaveId },
    { forcePool: DbPoolName.WRITE }
  );
  const scopes = new Map(
    rows.map((row) => {
      const scope = scopeFromRow(row, {
        chain,
        recordsWaveConfigured: recordsWaveId !== null
      });
      return [row.id, { stays: scope.stays, reasons: scope.reasons }];
    })
  );
  expect(staying.map((it) => it.id).sort()).toEqual(
    Array.from(scopes.entries())
      .filter(([, scope]) => scope.stays)
      .map(([id]) => id)
      .sort()
  );
  return scopes;
}

/**
 * The chain index's two tables with the rows these cases need: each HELD
 * wave held by the chain, and the index's state, ready or not, on NETWORK.
 * Where the chain index's own schema made the tables (its entities are in
 * this tree), their rows are cleared and written as that schema takes
 * them, and cleared again after; where it didn't, the tables are made here
 * with the columns the scope reads, and dropped after.
 */
async function withChainIndex(ready: boolean, work: () => Promise<void>) {
  const opts = { forcePool: DbPoolName.WRITE };
  const existing = await sqlExecutor.execute<{ name: string }>(
    `select table_name as name from information_schema.tables
      where table_schema = database() and table_name in (:tables)`,
    { tables: [CHAIN_WAVES_TABLE_NAME, CHAIN_INDEX_STATE_TABLE_NAME] },
    opts
  );
  const indexSchema = existing.length === 2;
  const clear = async () => {
    await sqlExecutor.execute(
      `delete from ${CHAIN_WAVES_TABLE_NAME}`,
      undefined,
      opts
    );
    await sqlExecutor.execute(
      `delete from ${CHAIN_INDEX_STATE_TABLE_NAME}`,
      undefined,
      opts
    );
  };
  if (indexSchema) {
    await clear();
  } else {
    await sqlExecutor.execute(
      `create table ${CHAIN_WAVES_TABLE_NAME} (wave_id varchar(100) primary key, legacy_id varchar(100) null, origin varchar(16) not null)`,
      undefined,
      opts
    );
    await sqlExecutor.execute(
      `create table ${CHAIN_INDEX_STATE_TABLE_NAME} (name varchar(64) primary key, last_full_at bigint null, network varchar(100) null, last_error text null, feed_next bigint null, read_height bigint null, feed_part int null, full_phase varchar(32) null, updated_at bigint null)`,
      undefined,
      opts
    );
  }
  try {
    for (const id of Array.from(HELD)) {
      // An imported wave is named by its LegacyId, a chain-made one by its
      // chain id.
      const chainMade = id.startsWith('0x');
      const row = {
        waveId: chainMade ? id : '0x' + Buffer.from(id).toString('hex'),
        legacyId: chainMade ? null : id,
        origin: chainMade ? NATIVE_ORIGIN : IMPORTED_ORIGIN
      };
      await sqlExecutor.execute(
        indexSchema
          ? `insert into ${CHAIN_WAVES_TABLE_NAME} (wave_id, legacy_id, status, members_only, origin, height, generation, data) values (:waveId, :legacyId, 'open', false, :origin, 1, 1, '{}')`
          : `insert into ${CHAIN_WAVES_TABLE_NAME} (wave_id, legacy_id, origin) values (:waveId, :legacyId, :origin)`,
        row,
        opts
      );
    }
    await sqlExecutor.execute(
      indexSchema
        ? `insert into ${CHAIN_INDEX_STATE_TABLE_NAME} (name, last_full_at, network, updated_at) values (:name, :at, :network, 1)`
        : `insert into ${CHAIN_INDEX_STATE_TABLE_NAME} (name, last_full_at, network) values (:name, :at, :network)`,
      { name: CHAIN_INDEX_STATE_ROW, at: ready ? 1 : null, network: NETWORK },
      opts
    );
    await work();
  } finally {
    if (indexSchema) {
      await clear();
    } else {
      await sqlExecutor.execute(
        `drop table if exists ${CHAIN_WAVES_TABLE_NAME}`,
        undefined,
        opts
      );
      await sqlExecutor.execute(
        `drop table if exists ${CHAIN_INDEX_STATE_TABLE_NAME}`,
        undefined,
        opts
      );
    }
  }
}

/** Each read asks the chain index again, as the cases change it. */
const NO_CACHE = { readyCacheMs: 0, notReadyCacheMs: 0 };

const BEFORE: [ChainStateSql, (id: string) => ChainState] = [
  { switchedOn: false },
  () => ({ switchedOn: false })
];
const MAPPED: [ChainStateSql, (id: string) => ChainState] = [
  { switchedOn: true, heldSql: waveOnChainSql },
  (id) => ({ switchedOn: true, held: HELD.has(id) })
];
const NOT_READY: [ChainStateSql, (id: string) => ChainState] = [
  { switchedOn: true, heldSql: null },
  () => ({ switchedOn: true, held: null })
];

describeWithSeed(
  'the waves scope on the database',
  [
    withUserGroups(GROUPS),
    withWaves(WAVES),
    { table: WAVE_CURATIONS_TABLE, rows: CURATIONS },
    { table: COMPETITIONS_TABLE, rows: DECISIONS }
  ],
  () => {
    const names = [
      RECORDS_WAVE_ID_ENV,
      WAVES_FREEZE_AT_ENV,
      CHAIN_NETWORK_ID_ENV
    ];
    const original = names.map((name) => process.env[name]);
    beforeEach(() => {
      process.env[WAVES_FREEZE_AT_ENV] = new Date(FREEZE).toISOString();
    });
    afterEach(() => {
      names.forEach((name, index) => {
        if (original[index] === undefined) delete process.env[name];
        else process.env[name] = original[index];
      });
    });

    it.each([
      ['before the switch-on', null, BEFORE],
      ['before the switch-on', 'records', BEFORE],
      // SQL matches the id without regard to case, as the column's collation
      // does; the TypeScript form does the same.
      ['before the switch-on', 'RECORDS', BEFORE],
      ['after the switch-on', 'records', MAPPED],
      ['before the index has read the chain', 'records', NOT_READY]
    ] as const)(
      'the SQL form agrees with the TypeScript form (%s, records wave %s)',
      async (_name, recordsWaveId, [chainSql, chainOf]) => {
        const check = async () => {
          const sql = await sqlScopes(recordsWaveId, chainSql);
          expect(Array.from(sql.keys()).sort()).toEqual(
            WAVES.map((it) => it.id).sort()
          );
          for (const entity of WAVES) {
            const ts = staysOnSite(scopeWave(entity), GROUPS_BY_ID, {
              recordsWaveId,
              freezeAtMs: FREEZE,
              chain: chainOf(entity.id)
            });
            expect({ id: entity.id, ...sql.get(entity.id) }).toEqual({
              id: entity.id,
              stays: ts.stays,
              reasons: ts.reasons
            });
          }
        };
        if (chainSql.switchedOn) await withChainIndex(true, check);
        else await check();
      }
    );

    it('keeps the waves the rule keeps, for the reasons it gives', async () => {
      const sql = await sqlScopes('records', { switchedOn: false });
      const reasons = Object.fromEntries(
        Array.from(sql.entries()).map(([id, scope]) => [id, scope.reasons])
      );
      const hidden = [StayReason.HIDDEN_OR_PRIVATE_GROUP];
      const parent = [StayReason.PARENT_STAYS];
      expect(reasons).toEqual({
        moving: [],
        dm: [StayReason.DIRECT_MESSAGE],
        records: [StayReason.RECORDS_WAVE],
        'members-only': [StayReason.MEMBERS_ONLY],
        'admin-hidden': hidden,
        'chat-private': hidden,
        'dm-group-user': hidden,
        'hub-submit-hidden': hidden,
        'hub-vote-private': hidden,
        'curation-hidden': hidden,
        'decision-submit-hidden': hidden,
        'decision-hub': hidden,
        'decision-legacy': hidden,
        'missing-group': hidden,
        'late-group-user': [StayReason.GROUP_CREATED_AFTER_FREEZE],
        'chat-off': [StayReason.CHAT_DISABLED_NO_ADMIN_GROUP],
        'chat-off-admin': [],
        'late-wave': [StayReason.CREATED_AFTER_FREEZE],
        subwave: parent,
        'sub-subwave': parent,
        'sub-of-hidden': parent,
        orphan: parent,
        'under-orphan': parent,
        'sub-of-moving': [],
        'self-parent': hidden,
        [CHAIN_MADE]: []
      });
    });

    it('reads scopes, and which groups a moving wave uses', async () => {
      process.env[RECORDS_WAVE_ID_ENV] = 'records';
      const service = new WavesScopeService(dbSupplier, () => false, NO_CACHE);
      const scopes = await service.waveScopes(
        ['moving', 'members-only', 'records', 'sub-subwave', 'no-such-wave'],
        {}
      );
      expect(scopes.get('moving')?.stays).toBe(false);
      expect(scopes.get('members-only')?.reasons).toEqual([
        StayReason.MEMBERS_ONLY
      ]);
      expect(scopes.get('sub-subwave')?.reasons).toEqual([
        StayReason.PARENT_STAYS
      ]);
      expect(scopes.get('records')).toEqual({
        stays: true,
        reasons: [StayReason.RECORDS_WAVE],
        recordsWaveConfigured: true,
        movedOnChain: false
      });
      expect(scopes.has('no-such-wave')).toBe(false);
      expect(await service.waveStays('no-such-wave', {})).toBe(false);
      expect(await service.waveStays('dm', {})).toBe(true);
      expect(await service.waveStays('late-wave', {})).toBe(true);

      // A public group a moving wave and a staying wave both use is held.
      expect(await service.usedByMovingWave(['shared'], {})).toBe(true);
      // So is one only a moving wave's curation or decision uses.
      expect(await service.usedByMovingWave(['public'], {})).toBe(true);
      // Groups only staying waves use are not.
      expect(await service.usedByMovingWave(['members'], {})).toBe(false);
      expect(
        await service.usedByMovingWave(['hidden', 'private', 'late-group'], {})
      ).toBe(false);
      expect(await service.usedByMovingWave([], {})).toBe(false);
    });

    it('after the switch-on, moves only what the chain holds, and holds its groups', async () => {
      process.env[RECORDS_WAVE_ID_ENV] = 'records';
      process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
      const service = new WavesScopeService(dbSupplier, () => true, NO_CACHE);
      await withChainIndex(true, async () => {
        const scopes = await service.waveScopes(
          ['moving', 'members-only', 'admin-hidden', 'sub-of-moving', 'dm'],
          {}
        );
        expect(scopes.get('moving')).toEqual({
          stays: false,
          reasons: [],
          recordsWaveConfigured: true,
          movedOnChain: true
        });
        // Held by the chain: moved, whatever the rule says.
        expect(scopes.get('members-only')?.movedOnChain).toBe(true);
        // Not held: stays, whatever the rule says.
        expect(scopes.get('sub-of-moving')?.reasons).toEqual([
          StayReason.NOT_ON_CHAIN
        ]);
        expect(scopes.get('admin-hidden')?.reasons).toEqual([
          StayReason.HIDDEN_OR_PRIVATE_GROUP,
          StayReason.NOT_ON_CHAIN
        ]);
        // A direct message stays even where the chain names it.
        expect(scopes.get('dm')?.stays).toBe(true);
        expect(await service.usedByMovingWave(['members'], {})).toBe(true);
        expect(await service.usedByMovingWave(['hidden'], {})).toBe(false);
      });
      // Until the index has read the chain, the rule decides: an imported
      // wave stays frozen (neither moved nor open), a staying one stays
      // open, and only a chain-made wave has moved.
      const frozenUntilReady = async () => {
        const scopes = await service.waveScopes(
          ['moving', 'members-only', CHAIN_MADE],
          {}
        );
        expect(scopes.get('moving')).toEqual({
          stays: false,
          reasons: [],
          recordsWaveConfigured: true,
          movedOnChain: false
        });
        expect(scopes.get('members-only')?.reasons).toEqual([
          StayReason.MEMBERS_ONLY
        ]);
        expect(scopes.get(CHAIN_MADE)?.movedOnChain).toBe(true);
        expect(await service.usedByMovingWave(['shared'], {})).toBe(true);
      };
      await withChainIndex(false, frozenUntilReady);
      // Ready, but on another chain than the one expected: not ready.
      process.env[CHAIN_NETWORK_ID_ENV] = '0x' + 'ff'.repeat(32);
      await withChainIndex(true, frozenUntilReady);
      // With no expected network, no chain's read counts.
      delete process.env[CHAIN_NETWORK_ID_ENV];
      await withChainIndex(true, frozenUntilReady);
      process.env[CHAIN_NETWORK_ID_ENV] = NETWORK;
      await withChainIndex(true, async () => {
        expect(await service.waveStays('moving', {})).toBe(false);
        expect(await service.waveStays('sub-of-moving', {})).toBe(true);
      });
      // Switched on before the chain's tables are there (a switch-on time
      // set too early): everything frozen stays frozen.
      await frozenUntilReady();
    });

    it('holds a group only a moving subwave uses, and frees one only a staying subwave uses', async () => {
      const service = new WavesScopeService(dbSupplier, () => false, NO_CACHE);
      expect(await service.usedByMovingWave(['sub-moving-group'], {})).toBe(
        true
      );
      expect(await service.usedByMovingWave(['sub-group'], {})).toBe(false);
    });
  }
);
