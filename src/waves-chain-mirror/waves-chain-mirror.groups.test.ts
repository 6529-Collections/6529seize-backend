import {
  FilterDirection,
  GroupTdhInclusionStrategy
} from '@/entities/IUserGroup';
import {
  chainGroupOf,
  groupDefinitionOf,
  groupRowOf,
  groupShapeOf,
  EVERYONE_CRITERIA,
  MAX_VOTE_ABS,
  NO_CRITERIA
} from './waves-chain-mirror.groups';

const G = `0x${'0a'.repeat(32)}`;
const P1 = `0x${'11'.repeat(32)}`;
const P2 = `0x${'22'.repeat(32)}`;
const RATER = `0x${'33'.repeat(32)}`;
const CATEGORY = `0x${'44'.repeat(32)}`;
const ADDRESS = `0x${'5e'.repeat(20)}`;
const MAX = MAX_VOTE_ABS.toString();

const clause = (
  metric: string,
  min: string | number,
  max: string | number,
  extra: Record<string, unknown> = {}
) => ({
  metric,
  metricCode: 0,
  category: null,
  rater: null,
  min: String(min),
  max: String(max),
  ...extra
});

const group = (definition: Record<string, unknown>) => ({
  groupId: G,
  legacyId: null,
  version: 1,
  controller: P1,
  visibility: 'public',
  activeFrom: 1_764_000_000_000,
  origin: 'native',
  definition: {
    version: 1,
    defHash: null,
    predicateMode: 'all_clauses',
    clauses: [],
    includes: [],
    excludes: [],
    storedIncludes: 0,
    storedExcludes: 0,
    activationHeight: 10,
    ...definition
  }
});

const shapeOf = (definition: Record<string, unknown>) =>
  groupShapeOf(groupDefinitionOf(group(definition))!);

describe('waves chain mirror groups', () => {
  it('reads a chain_groups row', () => {
    expect(
      chainGroupOf({
        group_id: G.toUpperCase().replace('0X', '0x'),
        legacy_id: null,
        version: '2',
        origin: 'native',
        data: group({ includes: [{ kind: 'principal', value: P1 }] })
      })
    ).toMatchObject({
      groupId: G,
      version: 2,
      controller: P1,
      activeFrom: 1_764_000_000_000,
      definition: {
        mode: 'all_clauses',
        includes: [{ kind: 'principal', value: P1 }]
      }
    });
    expect(
      groupDefinitionOf(group({ includes: [{ kind: 'other', value: 'x' }] }))
    ).toBeNull();
    // The driver hands a JSON column over as text.
    expect(
      chainGroupOf({
        group_id: G,
        legacy_id: null,
        version: 1,
        origin: 'native',
        data: JSON.stringify(group({}))
      }).definition
    ).toMatchObject({ version: 1, mode: 'all_clauses' });
  });

  it('keeps a list-only group as its lists', () => {
    expect(
      shapeOf({
        predicateMode: 'list_only',
        includes: [
          { kind: 'principal', value: P1 },
          { kind: 'address', value: ADDRESS }
        ],
        excludes: [{ kind: 'principal', value: P2 }]
      })
    ).toEqual({
      ok: true,
      criteria: NO_CRITERIA,
      includes: [
        { kind: 'principal', value: P1 },
        { kind: 'address', value: ADDRESS }
      ],
      excludes: [{ kind: 'principal', value: P2 }]
    });
  });

  it('maps each metric to its criterion, a bound at maxVoteAbs to none', () => {
    const shape = shapeOf({
      clauses: [
        clause('tdh', 100, MAX),
        clause('level', `-${MAX}`, 40),
        clause('nic', 5, 10),
        clause('rep', 1, MAX, {
          category: { id: CATEGORY, name: 'Art' },
          rater: RATER
        })
      ],
      includes: [{ kind: 'principal', value: P1 }]
    });
    expect(shape).toEqual({
      ok: true,
      criteria: {
        tdh_min: 100,
        tdh_max: null,
        rep_min: 1,
        rep_max: null,
        rep_category: 'Art',
        rep_rater: RATER,
        cic_min: 5,
        cic_max: 10,
        level_min: null,
        level_max: 40
      },
      includes: [{ kind: 'principal', value: P1 }],
      excludes: []
    });
  });

  it('intersects two clauses on a metric: the import\'s "nobody" stays nobody', () => {
    const shape = shapeOf({
      clauses: [clause('level', 1, MAX), clause('level', `-${MAX}`, 0)],
      includes: [{ kind: 'principal', value: P1 }]
    });
    expect(shape).toMatchObject({
      ok: true,
      criteria: { level_min: 1, level_max: 0 },
      includes: [{ kind: 'principal', value: P1 }]
    });
  });

  it('reads TDH plus xTDH as TDH, as the import does', () => {
    expect(shapeOf({ clauses: [clause('tdh_xtdh', 10, 20)] })).toMatchObject({
      ok: true,
      criteria: { tdh_min: 10, tdh_max: 20 }
    });
  });

  it('lets everyone not excluded into a group whose criteria are none, by a criterion every identity meets', () => {
    expect(
      shapeOf({
        includes: [{ kind: 'principal', value: P1 }],
        excludes: [{ kind: 'principal', value: P2 }]
      })
    ).toEqual({
      ok: true,
      criteria: EVERYONE_CRITERIA,
      includes: null,
      excludes: [{ kind: 'principal', value: P2 }]
    });
    expect(EVERYONE_CRITERIA).toEqual({ ...NO_CRITERIA, tdh_min: 0 });
  });

  it('reads a group whose clauses all fall away as everyone, by the same criterion', () => {
    for (const clauses of [[], [clause('tdh', `-${MAX}`, MAX)]]) {
      expect(
        shapeOf({ clauses, includes: [{ kind: 'principal', value: P1 }] })
      ).toEqual({
        ok: true,
        criteria: EVERYONE_CRITERIA,
        includes: null,
        excludes: []
      });
    }
  });

  it('holds back what community_groups has no column for', () => {
    expect(
      shapeOf({
        clauses: [
          clause('rep', 1, 5, { category: { id: CATEGORY, name: 'Art' } }),
          clause('rep', 1, 5, { category: { id: G, name: 'Music' } })
        ]
      })
    ).toEqual({ ok: false, reason: 'group_rep_clauses' });
    expect(
      shapeOf({
        clauses: [
          clause('rep', 1, 5, { category: { id: CATEGORY, name: null } })
        ]
      })
    ).toEqual({ ok: false, reason: 'group_rep_category_unnamed' });
    expect(shapeOf({ clauses: [clause('owns', 1, 5)] })).toEqual({
      ok: false,
      reason: 'group_metric_unknown'
    });
    expect(shapeOf({ storedIncludes: 20 })).toEqual({
      ok: false,
      reason: 'group_stored_members'
    });
  });

  it('writes a community_groups row with no NFT or grant criteria', () => {
    const row = groupRowOf({
      id: G,
      name: 'Group',
      createdAt: new Date(1_764_000_000_000),
      createdBy: 'profile-1',
      criteria: { ...NO_CRITERIA, rep_min: 1, rep_category: 'Art' },
      repUser: 'profile-2',
      includeListId: 'list-1',
      excludeListId: null,
      visible: true,
      isPrivate: false
    });
    expect(row).toMatchObject({
      id: G,
      rep_min: 1,
      rep_category: 'Art',
      rep_user: 'profile-2',
      rep_direction: FilterDirection.Received,
      cic_user: null,
      tdh_inclusion_strategy: GroupTdhInclusionStrategy.TDH,
      owns_meme: false,
      owns_nextgen: false,
      is_beneficiary_of_grant_id: null,
      profile_group_id: 'list-1',
      excluded_profile_group_id: null,
      is_direct_message: false
    });
  });
});
