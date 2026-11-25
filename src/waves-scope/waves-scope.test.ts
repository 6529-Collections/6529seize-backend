import {
  COMPETITIONS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_CURATIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  ancestorsOf,
  chainWaveIdSql,
  groupStays,
  groupStaysSql,
  isChainWaveId,
  MAX_WAVE_DEPTH,
  MOVED_ON_CHAIN_COLUMN,
  movingWaveUsesGroupsSql,
  NO_RECORDS_WAVE,
  readRecordsWaveSetting,
  RECORDS_WAVE_ID_ENV,
  SCOPE_SQL_PARAMS,
  SCOPE_TABLES,
  scopeFromRow,
  scopeGroupIds,
  ScopeGroup,
  ScopeWave,
  STAY_REASONS,
  StayReason,
  staysOnSite,
  walkedGroupIds,
  waveUsesGroupsSql,
  wavesScopeSql
} from '@/waves-scope/waves-scope';

const FREEZE = Date.UTC(2026, 10, 25);
const BEFORE = FREEZE - 1;
const AFTER = FREEZE + 1;

type GroupFields = Omit<ScopeGroup, 'id'>;
const PUBLIC: GroupFields = { visible: true, is_private: false };
const HIDDEN: GroupFields = { visible: false, is_private: false };
const PRIVATE: GroupFields = { visible: true, is_private: true };
const DM_GROUP: GroupFields = { ...PUBLIC, is_direct_message: true };
const LATE: GroupFields = { ...PUBLIC, created_at: AFTER };

function wave(overrides: Partial<ScopeWave> = {}): ScopeWave {
  return {
    id: 'wave',
    is_direct_message: false,
    visibility_group_id: null,
    admin_group_id: null,
    chat_group_id: null,
    hub_group_ids: [],
    curation_group_ids: [],
    decision_group_ids: [],
    chat_enabled: true,
    created_at: BEFORE,
    ...overrides
  };
}

function groups(entries: Record<string, GroupFields>) {
  return new Map(Object.entries(entries));
}

const NO_RECORDS = { recordsWaveId: null, freezeAtMs: FREEZE };
const CHAIN_ID = '0x' + 'ab'.repeat(32);
const after = (held: boolean | null) => ({
  recordsWaveId: 'records',
  freezeAtMs: FREEZE,
  chain: { switchedOn: true as const, held }
});

describe('groupStays', () => {
  it('keeps a hidden, a private or a direct message group on 6529.io', () => {
    expect(groupStays(HIDDEN)).toBe(true);
    expect(groupStays(PRIVATE)).toBe(true);
    expect(groupStays({ visible: false, is_private: true })).toBe(true);
    expect(groupStays(DM_GROUP)).toBe(true);
  });

  it('keeps a group made after the freeze, when the freeze time is known', () => {
    expect(groupStays(LATE, FREEZE)).toBe(true);
    expect(groupStays({ ...PUBLIC, created_at: FREEZE }, FREEZE)).toBe(false);
    expect(groupStays(LATE)).toBe(false);
  });

  it('moves a visible public group', () => {
    expect(groupStays(PUBLIC, FREEZE)).toBe(false);
  });
});

describe('staysOnSite', () => {
  it('moves a public wave that uses only public groups', () => {
    const scope = staysOnSite(
      wave({
        admin_group_id: 'g',
        chat_group_id: 'g',
        hub_group_ids: ['g', null],
        curation_group_ids: ['g'],
        decision_group_ids: ['g', null]
      }),
      groups({ g: PUBLIC }),
      NO_RECORDS
    );
    expect(scope).toEqual({
      stays: false,
      reasons: [],
      recordsWaveConfigured: false,
      movedOnChain: false
    });
  });

  it('keeps a direct message', () => {
    expect(
      staysOnSite(wave({ is_direct_message: true }), groups({}), NO_RECORDS)
        .reasons
    ).toEqual([StayReason.DIRECT_MESSAGE]);
  });

  it('keeps the records wave, by id only', () => {
    const options = { recordsWaveId: 'records' };
    const records = staysOnSite(wave({ id: 'records' }), groups({}), options);
    expect(records.reasons).toEqual([StayReason.RECORDS_WAVE]);
    expect(records.recordsWaveConfigured).toBe(true);
    expect(staysOnSite(wave({ id: 'other' }), groups({}), options).stays).toBe(
      false
    );
  });

  it('matches the records wave id without regard to case, as SQL does', () => {
    const upper = staysOnSite(wave({ id: 'records' }), groups({}), {
      recordsWaveId: 'RECORDS'
    });
    expect(upper.reasons).toEqual([StayReason.RECORDS_WAVE]);
  });

  it('keeps no wave as the records wave when the id is unset', () => {
    const scope = staysOnSite(wave({ id: 'records' }), groups({}), NO_RECORDS);
    expect(scope.stays).toBe(false);
    expect(scope.recordsWaveConfigured).toBe(false);
  });

  it('keeps a members-only wave, whatever its visibility group is', () => {
    expect(
      staysOnSite(
        wave({ visibility_group_id: 'members' }),
        groups({ members: PUBLIC }),
        NO_RECORDS
      ).reasons
    ).toEqual([StayReason.MEMBERS_ONLY]);
  });

  const walked: [string, Partial<ScopeWave>][] = [
    ['admin group', { admin_group_id: 'secret' }],
    ['chat group', { chat_group_id: 'secret' }],
    ['hub submit group', { hub_group_ids: ['secret', null] }],
    ['hub vote group', { hub_group_ids: [null, 'secret'] }],
    ['curation group', { curation_group_ids: ['public', 'secret'] }],
    ['decision submit or vote group', { decision_group_ids: ['secret'] }]
  ];

  it.each(walked)(
    'keeps a wave whose %s is hidden, private, a direct message group or has no row',
    (_name, overrides) => {
      for (const secret of [HIDDEN, PRIVATE, DM_GROUP, undefined]) {
        const lookup = groups(
          secret ? { secret, public: PUBLIC } : { public: PUBLIC }
        );
        expect(
          staysOnSite(wave(overrides), lookup, NO_RECORDS).reasons
        ).toEqual([StayReason.HIDDEN_OR_PRIVATE_GROUP]);
      }
    }
  );

  it.each(walked)(
    'keeps a wave whose %s was made after the freeze',
    (_name, overrides) => {
      expect(
        staysOnSite(
          wave(overrides),
          groups({ secret: LATE, public: PUBLIC }),
          NO_RECORDS
        ).reasons
      ).toEqual([StayReason.GROUP_CREATED_AFTER_FREEZE]);
      // A late group that is also private counts as late only.
      expect(
        staysOnSite(
          wave(overrides),
          groups({ secret: { ...PRIVATE, created_at: AFTER }, public: PUBLIC }),
          NO_RECORDS
        ).reasons
      ).toEqual([StayReason.GROUP_CREATED_AFTER_FREEZE]);
    }
  );

  it.each(walked)('moves a wave whose %s is public', (_name, overrides) => {
    expect(
      staysOnSite(
        wave(overrides),
        groups({ secret: PUBLIC, public: PUBLIC }),
        NO_RECORDS
      ).stays
    ).toBe(false);
  });

  it('treats an empty group id as no group', () => {
    expect(
      staysOnSite(
        wave({ admin_group_id: '', decision_group_ids: [''] }),
        groups({}),
        NO_RECORDS
      ).stays
    ).toBe(false);
  });

  it('keeps a wave whose chat is off and that has no admin group', () => {
    const off = wave({ chat_enabled: false });
    expect(staysOnSite(off, groups({}), NO_RECORDS).reasons).toEqual([
      StayReason.CHAT_DISABLED_NO_ADMIN_GROUP
    ]);
    expect(
      staysOnSite(
        wave({ chat_enabled: false, admin_group_id: 'admins' }),
        groups({ admins: PUBLIC }),
        NO_RECORDS
      ).stays
    ).toBe(false);
  });

  it('keeps a wave made after the freeze, when the freeze time is known', () => {
    expect(
      staysOnSite(wave({ created_at: AFTER }), groups({}), NO_RECORDS).reasons
    ).toEqual([StayReason.CREATED_AFTER_FREEZE]);
    expect(
      staysOnSite(wave({ created_at: FREEZE }), groups({}), NO_RECORDS).stays
    ).toBe(false);
    expect(
      staysOnSite(wave({ created_at: AFTER }), groups({}), {
        recordsWaveId: null,
        freezeAtMs: null
      }).stays
    ).toBe(false);
  });

  it('reports every reason that holds, in order', () => {
    const scope = staysOnSite(
      wave({
        id: 'records',
        is_direct_message: true,
        visibility_group_id: 'members',
        chat_group_id: 'secret',
        curation_group_ids: ['late'],
        chat_enabled: false,
        created_at: AFTER,
        parent_wave_id: 'parent',
        parent: wave({ id: 'parent', visibility_group_id: 'members' })
      }),
      groups({ secret: HIDDEN, late: LATE }),
      { recordsWaveId: 'records', freezeAtMs: FREEZE }
    );
    expect(scope.reasons).toEqual(
      STAY_REASONS.filter((reason) => reason !== StayReason.NOT_ON_CHAIN)
    );
    expect(scope.stays).toBe(true);
  });
});

describe('subwaves stay with the waves above them', () => {
  const lookup = groups({ secret: HIDDEN, public: PUBLIC });
  const root = wave({ id: 'root', visibility_group_id: 'members' });
  const child = wave({
    id: 'child',
    admin_group_id: 'public',
    parent_wave_id: 'root',
    parent: root
  });
  const grandchild = wave({
    id: 'grandchild',
    parent_wave_id: 'child',
    parent: child
  });

  it('keeps a public subwave of a staying wave, with parent_stays only', () => {
    expect(staysOnSite(child, lookup, NO_RECORDS).reasons).toEqual([
      StayReason.PARENT_STAYS
    ]);
  });

  it('walks up to the root', () => {
    expect(staysOnSite(grandchild, lookup, NO_RECORDS).reasons).toEqual([
      StayReason.PARENT_STAYS
    ]);
    expect(ancestorsOf(grandchild).map((it) => it.id)).toEqual([
      'child',
      'root'
    ]);
  });

  it('counts any own reason of a wave above, a hidden group or a late wave', () => {
    const top = wave({ id: 'top', chat_group_id: 'secret' });
    const sub = wave({ id: 'sub', parent: wave({ id: 'mid', parent: top }) });
    expect(staysOnSite(sub, lookup, NO_RECORDS).reasons).toEqual([
      StayReason.PARENT_STAYS
    ]);
    expect(scopeGroupIds(sub)).toEqual(['secret']);
    const late = wave({ id: 'sub', parent: wave({ created_at: AFTER }) });
    expect(staysOnSite(late, lookup, NO_RECORDS).stays).toBe(true);
  });

  it('keeps a subwave whose parent, or a wave above it, has no row', () => {
    expect(
      staysOnSite(
        wave({ id: 'orphan', parent_wave_id: 'gone', parent: null }),
        lookup,
        NO_RECORDS
      ).reasons
    ).toEqual([StayReason.PARENT_STAYS]);
    const sub = wave({
      id: 'sub',
      parent_wave_id: 'mid',
      parent: wave({ id: 'mid', parent_wave_id: 'gone', parent: null })
    });
    expect(staysOnSite(sub, lookup, NO_RECORDS).reasons).toEqual([
      StayReason.PARENT_STAYS
    ]);
  });

  it('moves a subwave when no wave above it stays', () => {
    const sub = wave({
      id: 'sub',
      parent_wave_id: 'mid',
      parent: wave({
        id: 'mid',
        parent_wave_id: 'top',
        parent: wave({ id: 'top' })
      })
    });
    expect(staysOnSite(sub, lookup, NO_RECORDS).stays).toBe(false);
  });

  it('stops at a loop in the parents and at the depth limit', () => {
    const a: { -readonly [K in keyof ScopeWave]: ScopeWave[K] } = wave({
      id: 'a'
    });
    const b = wave({ id: 'b', parent: a });
    a.parent = b;
    expect(ancestorsOf(a).map((it) => it.id)).toEqual(['b']);
    expect(staysOnSite(a, lookup, NO_RECORDS).stays).toBe(false);
    // A wave that names itself as its parent is not its own ancestor.
    const self: { -readonly [K in keyof ScopeWave]: ScopeWave[K] } = wave({
      id: 'self',
      parent_wave_id: 'self'
    });
    self.parent = self;
    expect(ancestorsOf(self)).toEqual([]);
    let deep = wave({ id: 'w0', visibility_group_id: 'members' });
    for (let i = 1; i <= MAX_WAVE_DEPTH + 1; i++)
      deep = wave({ id: `w${i}`, parent: deep });
    expect(ancestorsOf(deep)).toHaveLength(MAX_WAVE_DEPTH);
    expect(staysOnSite(deep, lookup, NO_RECORDS).stays).toBe(false);
  });
});

describe('after the switch-on', () => {
  const members = wave({ visibility_group_id: 'members' });
  const lookup = groups({});

  it('moves a wave the chain holds, whatever the rule says', () => {
    expect(staysOnSite(members, lookup, after(true))).toEqual({
      stays: false,
      reasons: [],
      recordsWaveConfigured: true,
      movedOnChain: true
    });
  });

  it('keeps a wave the chain does not hold, whatever the rule says', () => {
    expect(staysOnSite(wave(), lookup, after(false))).toEqual({
      stays: true,
      reasons: [StayReason.NOT_ON_CHAIN],
      recordsWaveConfigured: true,
      movedOnChain: false
    });
    expect(staysOnSite(members, lookup, after(false)).reasons).toEqual([
      StayReason.MEMBERS_ONLY,
      StayReason.NOT_ON_CHAIN
    ]);
  });

  it('keeps direct messages and the records wave even where the chain holds them', () => {
    expect(
      staysOnSite(wave({ is_direct_message: true }), lookup, after(true))
        .reasons
    ).toEqual([StayReason.DIRECT_MESSAGE, StayReason.NOT_ON_CHAIN]);
    expect(
      staysOnSite(wave({ id: 'records' }), lookup, after(true)).stays
    ).toBe(true);
  });

  it('keeps the rule until the index is ready: a moving wave stays frozen', () => {
    // An imported public wave: neither moved nor open.
    expect(staysOnSite(wave(), lookup, after(null))).toEqual({
      stays: false,
      reasons: [],
      recordsWaveConfigured: true,
      movedOnChain: false
    });
    // A wave that stays by the rule stays open, with the rule's reasons.
    expect(staysOnSite(members, lookup, after(null)).reasons).toEqual([
      StayReason.MEMBERS_ONLY
    ]);
    // A wave made on the chain has moved.
    expect(
      staysOnSite(wave({ id: CHAIN_ID }), lookup, after(null)).movedOnChain
    ).toBe(true);
  });

  it('reopens a wave the chain does not hold once the index is ready', () => {
    const imported = wave();
    expect(staysOnSite(imported, lookup, after(null)).stays).toBe(false);
    expect(staysOnSite(imported, lookup, after(true)).movedOnChain).toBe(true);
    expect(staysOnSite(imported, lookup, after(false)).reasons).toEqual([
      StayReason.NOT_ON_CHAIN
    ]);
  });

  it('knows a chain id', () => {
    expect(isChainWaveId(CHAIN_ID)).toBe(true);
    expect(isChainWaveId('0x' + 'AB'.repeat(32))).toBe(true);
    expect(isChainWaveId('0x' + 'ab'.repeat(31))).toBe(false);
    expect(isChainWaveId('8d5e0ac5-4b3e-4f7c-9a77-1f0c2a6e8b11')).toBe(false);
  });
});

describe('walkedGroupIds', () => {
  it('lists each used group once, without the visibility group, nulls or empty ids', () => {
    expect(
      walkedGroupIds(
        wave({
          visibility_group_id: 'members',
          admin_group_id: 'a',
          chat_group_id: 'a',
          hub_group_ids: ['h', null],
          curation_group_ids: ['c', ''],
          decision_group_ids: [null, 'd', 'h']
        })
      )
    ).toEqual(['a', 'h', 'c', 'd']);
  });
});

describe('readRecordsWaveSetting', () => {
  it('reads an id, none, or unset', () => {
    expect(
      readRecordsWaveSetting({ [RECORDS_WAVE_ID_ENV]: ' records ' })
    ).toEqual({ kind: 'id', id: 'records' });
    // Wave ids are lower case; one typed in another case still matches.
    expect(
      readRecordsWaveSetting({ [RECORDS_WAVE_ID_ENV]: 'Records-ABC' })
    ).toEqual({ kind: 'id', id: 'records-abc' });
    for (const none of ['none', 'NONE', ' None '])
      expect(readRecordsWaveSetting({ [RECORDS_WAVE_ID_ENV]: none })).toEqual({
        kind: NO_RECORDS_WAVE
      });
    for (const unset of [undefined, '', '  '])
      expect(readRecordsWaveSetting({ [RECORDS_WAVE_ID_ENV]: unset })).toEqual({
        kind: 'unset'
      });
  });

  it('says whether the setting was set, an id or none', () => {
    const records = wave({ id: 'records' });
    expect(
      staysOnSite(records, groups({}), {
        recordsWaveId: null,
        recordsWaveConfigured: true
      }).recordsWaveConfigured
    ).toBe(true);
    expect(
      staysOnSite(records, groups({}), { recordsWaveId: null })
        .recordsWaveConfigured
    ).toBe(false);
  });
});

describe('the SQL form', () => {
  it('reads the tables the repository names', () => {
    expect(SCOPE_TABLES).toEqual({
      waves: WAVES_TABLE,
      groups: USER_GROUPS_TABLE,
      curations: WAVE_CURATIONS_TABLE,
      decisions: COMPETITIONS_TABLE
    });
  });

  it('keeps a hidden, private, direct message or late group', () => {
    expect(groupStaysSql('g')).toBe(
      '(g.visible = 0 or coalesce(g.is_private, 0) = 1 or coalesce(g.is_direct_message, 0) = 1)'
    );
    expect(groupStaysSql('g', SCOPE_SQL_PARAMS)).toContain(
      'g.created_at > :freezeAt'
    );
  });

  it('selects the id, every reason it reads and moved_on_chain', () => {
    const sql = wavesScopeSql('w');
    for (const reason of STAY_REASONS) {
      if (reason === StayReason.NOT_ON_CHAIN) continue;
      const column = sql.reasons[reason];
      expect(sql.select).toContain(`${column} as ${reason}`);
      expect(sql.stays).toContain(column);
    }
    expect(sql.select).toMatch(/^select w\.id as id, /);
    expect(
      sql.select.endsWith(`(0 = 1) as ${MOVED_ON_CHAIN_COLUMN} from waves w`)
    ).toBe(true);
    expect(sql.reasons[StayReason.RECORDS_WAVE]).toBe(
      '(:recordsWaveId is not null and w.id = :recordsWaveId)'
    );
    expect(sql.reasons[StayReason.CREATED_AFTER_FREEZE]).toBe(
      '(:freezeAtMs is not null and w.created_at > :freezeAtMs)'
    );
  });

  it('names its parameters as asked', () => {
    const sql = wavesScopeSql('w', undefined, {
      records: 'r',
      freezeAtMs: 'ms',
      freezeAt: 'at'
    }).stays;
    expect(sql).toContain(':r is not null');
    expect(sql).toContain(':ms is not null');
    expect(sql).toContain(':at is not null');
    expect(sql).not.toContain(':recordsWaveId');
  });

  it('walks the same groups as the TypeScript form', () => {
    const hidden =
      wavesScopeSql('w').reasons[StayReason.HIDDEN_OR_PRIVATE_GROUP];
    for (const part of [
      'w.admin_group_id',
      'w.chat_group_id',
      "json_value(w.hub_participation_config, '$.group_id')",
      "json_value(w.hub_voting_config, '$.group_id')",
      'w_c.wave_id = w.id',
      "json_value(w_d.participation_config, '$.group_id')",
      "json_value(w_d.voting_config, '$.group_id')",
      'w_d.wave_id = w.id or w_d.legacy_wave_id = w.id',
      // A group id with no row.
      'not exists (select 1 from community_groups w_m where w_m.id = w.admin_group_id)',
      'not exists (select 1 from community_groups w_m where w_m.id = w_mc.community_group_id)'
    ])
      expect(hidden).toContain(part);
    expect(hidden).not.toContain('participation_group_id');
    expect(hidden).not.toContain('voting_group_id');
    expect(hidden).not.toContain('parent_wave_id');
  });

  it('walks up the parents with a recursive query, to the depth limit', () => {
    const parent = wavesScopeSql('w').reasons[StayReason.PARENT_STAYS];
    expect(parent).toContain('with recursive w_anc');
    expect(parent).toContain('w_up.id = w.parent_wave_id');
    expect(parent).toContain(`w_anc.depth < ${MAX_WAVE_DEPTH}`);
    expect(parent).toContain("coalesce(w_aw.visibility_group_id, '') <> ''");
    expect(parent).toContain('w_pm.id = w.parent_wave_id');
  });

  it('decides by the chain after the switch-on', () => {
    expect(wavesScopeSql('w').moved).toBe('(0 = 1)');
    const held = (id: string) => `held(${id})`;
    const mapped = wavesScopeSql('w', { switchedOn: true, heldSql: held });
    expect(mapped.stays).toBe(`(not ${mapped.moved})`);
    expect(mapped.moved).toContain('held(w.id)');
    expect(mapped.stays).not.toContain('w_anc');
    const notReady = wavesScopeSql('w', { switchedOn: true, heldSql: null });
    expect(notReady.moved).toContain(chainWaveIdSql('w.id'));
    // Until the index is ready the rule still decides.
    expect(notReady.stays).toBe(
      `(not ${notReady.moved} and ${wavesScopeSql('w').stays})`
    );
  });

  it('keeps every statement under the 16,000 bytes past which RDS Proxy pins a session', () => {
    const held = (id: string) =>
      `(exists (select 1 from chain_waves cwm_legacy where cwm_legacy.legacy_id = ${id}) or exists (select 1 from chain_waves cwm_chain where cwm_chain.wave_id = ${id}))`;
    for (const chain of [
      undefined,
      { switchedOn: true as const, heldSql: held },
      { switchedOn: true as const, heldSql: null }
    ]) {
      const sql = wavesScopeSql('w', chain);
      expect(
        Buffer.byteLength(`${sql.select} where w.id in (:waveIds)`)
      ).toBeLessThan(12_000);
      expect(
        Buffer.byteLength(
          `select exists (select 1 from waves w where ${movingWaveUsesGroupsSql('w', 'groupIds', chain)}) as used`
        )
      ).toBeLessThan(12_000);
    }
  });

  it('finds the waves that use groups, and the moving ones among them', () => {
    const uses = waveUsesGroupsSql('w', 'ids');
    for (const part of [
      'w.visibility_group_id in (:ids)',
      'w.admin_group_id in (:ids)',
      'w.chat_group_id in (:ids)',
      "json_value(w.hub_participation_config, '$.group_id') in (:ids)",
      "json_value(w.hub_voting_config, '$.group_id') in (:ids)",
      'w_uc.community_group_id in (:ids)',
      "json_value(w_ud.voting_config, '$.group_id') in (:ids)"
    ])
      expect(uses).toContain(part);
    expect(movingWaveUsesGroupsSql('w', 'ids')).toBe(
      `(${uses} and not ${wavesScopeSql('w').stays})`
    );
  });
});

describe('scopeFromRow', () => {
  const row = (values: Record<string, number | string>) => ({
    id: 'w',
    ...values
  });
  const BEFORE = { switchedOn: false as const };
  const READY = { switchedOn: true as const, heldSql: (id: string) => id };
  const NOT_READY = { switchedOn: true as const, heldSql: null };

  it('reads the reasons a row says, in order', () => {
    expect(
      scopeFromRow(
        row({ parent_stays: '1', members_only: 1, moved_on_chain: 0 }),
        { chain: BEFORE, recordsWaveConfigured: true }
      )
    ).toEqual({
      stays: true,
      reasons: [StayReason.MEMBERS_ONLY, StayReason.PARENT_STAYS],
      recordsWaveConfigured: true,
      movedOnChain: false
    });
    expect(
      scopeFromRow(row({}), { chain: BEFORE, recordsWaveConfigured: false })
        .stays
    ).toBe(false);
  });

  it('after the switch-on, moves a moved wave and adds not_on_chain once the index is ready', () => {
    const ready = { chain: READY, recordsWaveConfigured: true };
    expect(
      scopeFromRow(row({ members_only: 1, moved_on_chain: 1 }), ready)
    ).toEqual({
      stays: false,
      reasons: [],
      recordsWaveConfigured: true,
      movedOnChain: true
    });
    expect(scopeFromRow(row({ moved_on_chain: 0 }), ready).reasons).toEqual([
      StayReason.NOT_ON_CHAIN
    ]);
    const notReady = { chain: NOT_READY, recordsWaveConfigured: true };
    expect(scopeFromRow(row({ moved_on_chain: 0 }), notReady).stays).toBe(
      false
    );
    expect(
      scopeFromRow(row({ members_only: 1, moved_on_chain: 0 }), notReady)
        .reasons
    ).toEqual([StayReason.MEMBERS_ONLY]);
  });
});
