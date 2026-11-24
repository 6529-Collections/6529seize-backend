import {
  groupStays,
  ScopeWave,
  STAY_REASONS,
  StayReason,
  staysOnSite,
  wavesScopeSql
} from '@/waves-scope/waves-scope';

/**
 * The cases of the shared rule (src/waves-scope, the backend's own file)
 * the export relies on: it leaves out what stays, whole.
 */
const RECORDS = 'w-records';
const GROUPS = new Map([
  ['g-public', { visible: true, is_private: false }],
  ['g-hidden', { visible: false, is_private: false }],
  ['g-private', { visible: true, is_private: true }]
]);

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
    ...fields
  };
}

const scope = (fields: Partial<ScopeWave>, id = 'w-1') =>
  staysOnSite(wave(id, fields), GROUPS, { recordsWaveId: RECORDS });

describe('which waves the export leaves out (src/waves-scope)', () => {
  it('keeps a public wave with a hidden admin group on 6529.io', () => {
    expect(scope({ admin_group_id: 'g-hidden' })).toMatchObject({
      stays: true,
      reasons: [StayReason.HIDDEN_OR_PRIVATE_GROUP]
    });
  });

  it('keeps a wave whole whatever group of it is hidden or private', () => {
    const cases: Partial<ScopeWave>[] = [
      { chat_group_id: 'g-private' },
      { curation_group_ids: ['g-public', 'g-hidden'] },
      { decision_group_ids: [null, 'g-private'] },
      { hub_group_ids: ['g-hidden'] }
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

  it('reports every reason, in order, and moves a wave with none', () => {
    expect(
      scope({
        is_direct_message: true,
        visibility_group_id: 'g-public',
        admin_group_id: 'g-private'
      }).reasons
    ).toEqual([
      StayReason.DIRECT_MESSAGE,
      StayReason.MEMBERS_ONLY,
      StayReason.HIDDEN_OR_PRIVATE_GROUP
    ]);
    expect(
      scope({ admin_group_id: 'g-public', chat_group_id: 'g-gone' })
    ).toMatchObject({ stays: false, reasons: [] });
  });

  it('keeps a hidden or private group on 6529.io', () => {
    expect(groupStays({ visible: true, is_private: false })).toBe(false);
    expect(groupStays({ visible: false, is_private: false })).toBe(true);
    expect(groupStays({ visible: true, is_private: true })).toBe(true);
  });

  it('gives each reason a column of one SQL select, the records wave bound', () => {
    const { select } = wavesScopeSql('sw', 'recordsWaveId');
    for (const reason of STAY_REASONS) {
      expect(select).toContain(` as ${reason}`);
    }
    expect(select).toContain(':recordsWaveId');
    expect(select).toContain('from waves sw');
  });
});
