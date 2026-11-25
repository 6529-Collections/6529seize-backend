import { groupCriteriaReasons, groupRaterKeys } from './waves-export.groups';

/**
 * Group definitions (made-up values) and the reasons the waves snapshot
 * tooling's Python `criteria_reasons` gives for them (tools/legacy-snapshot/
 * groups.py, validator commit 34d84750e), without and with --both-metric.
 */
const GROUPS: unknown[] = [
  {
    tdh: {
      min: 10,
      max: null,
      inclusion_strategy: 'TDH'
    },
    rep: {},
    cic: {},
    level: {},
    owns_nfts: []
  },
  {
    tdh: {
      min: 1,
      max: null,
      inclusion_strategy: 'BOTH'
    }
  },
  {
    tdh: {
      min: null,
      max: null,
      inclusion_strategy: 'XTDH'
    }
  },
  {
    tdh: {
      min: 0,
      max: null,
      inclusion_strategy: 'XTDH'
    }
  },
  {
    rep: {
      min: 5,
      max: null,
      direction: 'SENT',
      user_identity: null,
      category: 'Art'
    }
  },
  {
    rep: {
      min: null,
      max: null,
      direction: null,
      user_identity: 'someone',
      category: null
    }
  },
  {
    rep: {
      min: 1,
      max: null,
      direction: 'RECEIVED',
      user_identity: 'someone',
      category: 'Art'
    }
  },
  {
    cic: {
      min: 1,
      max: null,
      direction: 'RECEIVED',
      user_identity: null
    }
  },
  {
    cic: {
      min: null,
      max: null,
      direction: 'SENT',
      user_identity: 'someone'
    }
  },
  {
    owns_nfts: [
      {
        name: 'MEMES',
        tokens: ['1']
      }
    ]
  },
  {
    is_beneficiary_of_grant_id: 'grant-1'
  },
  {
    level: {
      min: 2,
      max: null
    },
    identity_group_id: 'ig-1'
  },
  {}
];

const PYTHON_REASONS: string[][][] = [
  [
    [],
    ['tdh strategy BOTH'],
    [],
    ['tdh strategy XTDH'],
    ['rep sent'],
    ['rep user without category'],
    [],
    [],
    ['nic sent', 'nic user'],
    ['nft ownership'],
    ['xtdh beneficiary'],
    [],
    []
  ],
  [
    [],
    [],
    [],
    ['tdh strategy XTDH'],
    ['rep sent'],
    ['rep user without category'],
    [],
    [],
    ['nic sent', 'nic user'],
    ['nft ownership'],
    ['xtdh beneficiary'],
    [],
    []
  ]
];

describe('groupCriteriaReasons', () => {
  it.each(GROUPS.map((group, index) => [index, group]))(
    "gives group %i the snapshot tooling's reasons",
    (index, group) => {
      const i = index as number;
      expect(groupCriteriaReasons(group)).toEqual(PYTHON_REASONS[0][i]);
      expect(groupCriteriaReasons(group, { bothMetric: true })).toEqual(
        PYTHON_REASONS[1][i]
      );
    }
  );
});

describe('groupRaterKeys', () => {
  it('names the REP and NIC raters', () => {
    expect(
      groupRaterKeys({
        rep: { user_identity: 'alice' },
        cic: { user_identity: 'bob' }
      })
    ).toEqual(['alice', 'bob']);
    expect(groupRaterKeys({ rep: { user_identity: null } })).toEqual([]);
    expect(groupRaterKeys(null)).toEqual([]);
  });
});
