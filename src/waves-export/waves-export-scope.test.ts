import {
  ChainStateSql,
  groupStays,
  MOVED_ON_CHAIN_COLUMN,
  ScopeWave,
  scopeFromRow,
  STAY_REASONS,
  StayReason,
  staysOnSite,
  wavesScopeSql
} from '@/waves-scope/waves-scope';
import { groupStayReason } from './waves-export.service';

/**
 * The cases of the shared rule (src/waves-scope, the backend's own file)
 * the export relies on: it leaves out what stays, whole, with the waves
 * freeze it runs at.
 */
const RECORDS = 'w-records';
const T_W = Date.UTC(2026, 10, 26);
const BEFORE = T_W - 60_000;
const AFTER = T_W + 1;
const GROUPS = new Map([
  ['g-public', { visible: true, is_private: false, created_at: BEFORE }],
  ['g-hidden', { visible: false, is_private: false, created_at: BEFORE }],
  ['g-private', { visible: true, is_private: true, created_at: BEFORE }],
  [
    'g-dm',
    {
      visible: true,
      is_private: false,
      is_direct_message: true,
      created_at: BEFORE
    }
  ],
  ['g-late', { visible: true, is_private: false, created_at: AFTER }]
]);
const RULE_BEFORE_SWITCH_ON: ChainStateSql = { switchedOn: false };

function wave(id: string, fields: Partial<ScopeWave> = {}): ScopeWave {
  return {
    id,
    is_direct_message: false,
    visibility_group_id: null,
    admin_group_id: null,
    chat_group_id: null,
    hub_group_ids: [],
    curation_group_ids: [],
    decision_group_ids: [],
    chat_enabled: true,
    created_at: BEFORE,
    ...fields
  };
}

const scope = (fields: Partial<ScopeWave>, id = 'w-1') =>
  staysOnSite(wave(id, fields), GROUPS, {
    recordsWaveId: RECORDS,
    freezeAtMs: T_W
  });

describe('which waves the export leaves out (src/waves-scope)', () => {
  it('keeps a public wave with a hidden admin group on 6529.io', () => {
    expect(scope({ admin_group_id: 'g-hidden' })).toMatchObject({
      stays: true,
      reasons: [StayReason.HIDDEN_OR_PRIVATE_GROUP]
    });
  });

  it('keeps a wave whole whatever group of it stays', () => {
    const cases: Partial<ScopeWave>[] = [
      { chat_group_id: 'g-private' },
      { curation_group_ids: ['g-public', 'g-hidden'] },
      { decision_group_ids: [null, 'g-private'] },
      { hub_group_ids: ['g-hidden'] },
      // A direct message's group, and a group id with no row.
      { chat_group_id: 'g-dm' },
      { chat_group_id: 'g-gone' },
      { decision_group_ids: ['g-gone'] }
    ];
    for (const fields of cases) {
      expect(scope(fields).reasons).toEqual([
        StayReason.HIDDEN_OR_PRIVATE_GROUP
      ]);
    }
  });

  it('keeps the records wave by its id, though its post group is ordinary', () => {
    expect(scope({ chat_group_id: 'g-public' }, RECORDS)).toMatchObject({
      stays: true,
      reasons: [StayReason.RECORDS_WAVE],
      recordsWaveConfigured: true
    });
  });

  it('keeps what the freeze came before: a wave or a group made after it', () => {
    expect(scope({ created_at: AFTER }).reasons).toEqual([
      StayReason.CREATED_AFTER_FREEZE
    ]);
    expect(scope({ admin_group_id: 'g-late' }).reasons).toEqual([
      StayReason.GROUP_CREATED_AFTER_FREEZE
    ]);
    // Made at the freeze itself is not after it.
    expect(scope({ created_at: T_W }).stays).toBe(false);
    // In a rehearsal the export has no freeze: neither reason holds.
    expect(
      staysOnSite(
        wave('w-1', { created_at: AFTER, admin_group_id: 'g-late' }),
        GROUPS,
        { recordsWaveId: RECORDS, freezeAtMs: null }
      ).stays
    ).toBe(false);
  });

  it('keeps a wave whose chat is off and that has no admin group to post in', () => {
    expect(scope({ chat_enabled: false }).reasons).toEqual([
      StayReason.CHAT_DISABLED_NO_ADMIN_GROUP
    ]);
    expect(
      scope({ chat_enabled: false, admin_group_id: 'g-public' }).stays
    ).toBe(false);
  });

  it('reports every reason, in order, and moves a wave with none', () => {
    expect(
      scope({
        is_direct_message: true,
        visibility_group_id: 'g-public',
        admin_group_id: 'g-private',
        chat_group_id: 'g-late',
        created_at: AFTER
      }).reasons
    ).toEqual([
      StayReason.DIRECT_MESSAGE,
      StayReason.MEMBERS_ONLY,
      StayReason.HIDDEN_OR_PRIVATE_GROUP,
      StayReason.GROUP_CREATED_AFTER_FREEZE,
      StayReason.CREATED_AFTER_FREEZE
    ]);
    expect(
      scope({ admin_group_id: 'g-public', chat_group_id: 'g-public' })
    ).toMatchObject({ stays: false, reasons: [] });
  });

  it('keeps a subwave when any wave above it stays, up to the root', () => {
    const members = wave('w-members', { visibility_group_id: 'g-public' });
    const dm = wave('w-dm', { is_direct_message: true });
    const between = wave('w-between', { parent: dm, parent_wave_id: 'w-dm' });
    expect(scope({ parent: members }, 'w-sub')).toMatchObject({
      stays: true,
      reasons: [StayReason.PARENT_STAYS]
    });
    expect(scope({ parent: between }, 'w-deep').reasons).toEqual([
      StayReason.PARENT_STAYS
    ]);
    // A direct message keeps its own reason; a public subwave of a public
    // wave moves.
    expect(scope({ is_direct_message: true, parent: members }).reasons).toEqual(
      [StayReason.DIRECT_MESSAGE, StayReason.PARENT_STAYS]
    );
    expect(scope({ parent: wave('w-public') }, 'w-sub2').stays).toBe(false);
  });

  it('keeps a subwave whose parent, or a wave above it, has no row', () => {
    expect(
      scope({ parent_wave_id: 'w-gone', parent: null }, 'w-orphan').reasons
    ).toEqual([StayReason.PARENT_STAYS]);
    const orphan = wave('w-orphan', { parent_wave_id: 'w-gone', parent: null });
    expect(
      scope({ parent_wave_id: 'w-orphan', parent: orphan }, 'w-under').reasons
    ).toEqual([StayReason.PARENT_STAYS]);
  });

  it('keeps a hidden, private, direct message or late group on 6529.io', () => {
    const base = { visible: true, is_private: false, created_at: BEFORE };
    expect(groupStays(base, T_W)).toBe(false);
    expect(groupStays({ ...base, visible: false }, T_W)).toBe(true);
    expect(groupStays({ ...base, is_private: true }, T_W)).toBe(true);
    expect(groupStays({ ...base, is_direct_message: true }, T_W)).toBe(true);
    expect(groupStays({ ...base, created_at: AFTER }, T_W)).toBe(true);
    expect(groupStays({ ...base, created_at: AFTER }, null)).toBe(false);
  });

  it('names why the groups stage leaves out a group, as the API shows it', () => {
    const api = {
      id: 'g',
      visible: true,
      is_private: false,
      is_direct_message: false,
      created_at: BEFORE
    };
    expect(groupStayReason(api, T_W)).toBe(null);
    expect(groupStayReason({ ...api, visible: false }, T_W)).toBe(
      StayReason.HIDDEN_OR_PRIVATE_GROUP
    );
    expect(groupStayReason({ ...api, is_private: true }, T_W)).toBe(
      StayReason.HIDDEN_OR_PRIVATE_GROUP
    );
    expect(groupStayReason({ ...api, is_direct_message: true }, T_W)).toBe(
      StayReason.DIRECT_MESSAGE
    );
    expect(groupStayReason({ ...api, created_at: AFTER }, T_W)).toBe(
      StayReason.GROUP_CREATED_AFTER_FREEZE
    );
    expect(
      groupStayReason({ ...api, created_at: AFTER, visible: false }, T_W)
    ).toBe(StayReason.GROUP_CREATED_AFTER_FREEZE);
    // A rehearsal: no freeze, so a late group is only what it is marked.
    expect(groupStayReason({ ...api, created_at: AFTER }, null)).toBe(null);
  });

  it('gives each reason a column of one SQL select, with the records wave and the freeze bound', () => {
    const { select } = wavesScopeSql('sw', RULE_BEFORE_SWITCH_ON);
    for (const reason of STAY_REASONS) {
      if (reason === StayReason.NOT_ON_CHAIN) continue;
      expect(select).toContain(` as ${reason}`);
    }
    expect(select).toContain(` as ${MOVED_ON_CHAIN_COLUMN}`);
    for (const param of [':recordsWaveId', ':freezeAtMs', ':freezeAt']) {
      expect(select).toContain(param);
    }
    expect(select).toContain('from waves sw');
    // parent_stays walks up to the root.
    expect(select).toContain('with recursive');
    // Under RDS Proxy's 16,000 bytes, with room for the export's join.
    expect(Buffer.byteLength(select)).toBeLessThan(12_000);
  });

  it('reads a row of the select as the rule says, before the switch-on', () => {
    const row = {
      id: 'w-1',
      direct_message: 0,
      records_wave: 0,
      members_only: '1',
      hidden_or_private_group: 0,
      group_created_after_freeze: 1,
      chat_disabled_no_admin_group: 0,
      created_after_freeze: 0,
      parent_stays: 1,
      [MOVED_ON_CHAIN_COLUMN]: 0
    };
    expect(
      scopeFromRow(row, {
        chain: RULE_BEFORE_SWITCH_ON,
        recordsWaveConfigured: true
      })
    ).toEqual({
      stays: true,
      reasons: [
        StayReason.MEMBERS_ONLY,
        StayReason.GROUP_CREATED_AFTER_FREEZE,
        StayReason.PARENT_STAYS
      ],
      recordsWaveConfigured: true,
      movedOnChain: false
    });
  });
});
