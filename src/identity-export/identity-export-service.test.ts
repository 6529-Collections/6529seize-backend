import {
  IdentityExportSource,
  IdentityRow,
  StatementRow
} from './identity-export.db';
import {
  buildIdentityExport,
  reservedHandles,
  shownClassification
} from './identity-export.service';
import { IdentityExportRating } from './identity-export.types';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P = (name: string) => `00000000-0000-4000-8000-${name.padStart(12, '0')}`;

function identity(
  key: string,
  profile: { id: string; handle: string; website?: string | null } | null,
  other: Partial<IdentityRow> = {}
): IdentityRow {
  return {
    consolidation_key: key,
    primary_address: key.split('-')[0],
    profile_id: profile?.id ?? null,
    classification: 'PSEUDONYM',
    sub_classification: null,
    pfp: null,
    banner1: null,
    banner2: null,
    tdh: 0,
    xtdh: 0,
    rep: 0,
    cic: 0,
    level_raw: 0,
    p_external_id: profile?.id ?? null,
    p_handle: profile?.handle ?? null,
    p_normalised_handle: profile?.handle.toLowerCase() ?? null,
    p_website: profile?.website ?? null,
    ...other
  };
}

function rating(
  rater: string,
  target: string,
  matter: 'REP' | 'CIC',
  category: string,
  value: number
): IdentityExportRating {
  return {
    rater_profile_id: rater,
    target_profile_id: target,
    matter,
    category,
    rating: value,
    last_modified_ms: 1_700_000_000_000
  };
}

const ALICE = P('a11ce');
const TAGGER = P('7a9');
const P1 = P('1');
const P2 = P('2');
const P3 = P('3');
const WAVER = P('4');
const GHOST = P('dead');

/** A small world: every kind of identity the scope rules decide on. */
function world(): {
  source: IdentityExportSource;
  calls: string[];
} {
  const rows: IdentityRow[] = [
    identity(
      W(1),
      { id: ALICE, handle: 'Alice', website: 'https://example.org' },
      {
        tdh: 1000.5,
        xtdh: 12.75,
        rep: 30,
        cic: 5,
        level_raw: 1043.25,
        pfp: 'ipfs://pfp'
      }
    ),
    identity(W(2), { id: TAGGER, handle: 'tagger' }),
    identity(W(3), { id: P1, handle: `id-${W(3)}` }),
    identity(W(4), { id: P2, handle: `id-${W(4)}` }),
    identity(W(5), { id: P3, handle: `id-${W(5)}` }),
    identity(`${W(6)}-${W(7)}`, null),
    identity(W(8), { id: WAVER, handle: `id-${W(8)}` })
  ];
  const wallets = new Map<string, string[]>([
    [W(1), [W(1)]],
    [W(2), [W(2)]],
    [W(3), [W(3)]],
    [W(4), [W(4)]],
    [W(5), [W(5)]],
    [`${W(6)}-${W(7)}`, [W(7), W(6)]],
    [W(8), [W(8)]]
  ]);
  const edges = [
    // A bulk category: three targets with a threshold of 2.
    rating(TAGGER, ALICE, 'REP', 'Holder', 1),
    rating(TAGGER, P1, 'REP', 'Holder', 1),
    rating(TAGGER, P2, 'REP', 'Holder', 1),
    // A normal rating of a placeholder brings it in.
    rating(ALICE, P3, 'REP', 'Good Person', -5),
    rating(P3, ALICE, 'CIC', '', 20),
    // A rating naming a profile with no identity is left out.
    rating(ALICE, GHOST, 'REP', 'Good Person', 2)
  ];
  const statements: StatementRow[] = [
    {
      id: 'st-2',
      profile_id: ALICE,
      statement_group: 'SOCIAL_MEDIA_ACCOUNT',
      statement_type: 'X',
      statement_value: 'alice',
      statement_comment: null,
      crated_at: new Date('2024-01-02T00:00:00Z')
    },
    {
      id: 'st-1',
      profile_id: ALICE,
      statement_group: 'GENERAL',
      statement_type: 'BIO',
      statement_value: 'hello',
      statement_comment: 'c',
      crated_at: '2024-01-01 00:00:00'
    }
  ];
  const calls: string[] = [];
  const byProfile = (ids: string[]) =>
    rows.filter((it) => it.p_external_id && ids.includes(it.p_external_id));
  const source: IdentityExportSource = {
    realHandleProfileIds: async () => {
      calls.push('realHandleProfileIds');
      return [ALICE, TAGGER];
    },
    multiWalletConsolidationKeys: async () => [`${W(6)}-${W(7)}`],
    ratingEdges: async () => edges,
    identitiesByProfileIds: async (ids) => {
      calls.push(`identitiesByProfileIds:${ids.length}`);
      return byProfile(ids);
    },
    identitiesByConsolidationKeys: async (keys) =>
      rows.filter((it) => keys.includes(it.consolidation_key)),
    walletsByConsolidationKeys: async (keys) =>
      new Map(keys.map((key) => [key, wallets.get(key) ?? []])),
    statementsByProfileIds: async (ids) =>
      statements.filter((it) => ids.includes(it.profile_id)),
    latestTdhBlock: async () => 24_000_000,
    delegations: async () => [
      {
        from_address: W(1),
        to_address: W(9),
        collection: W(10),
        use_case: 2,
        expiry: 64_060_588_800,
        all_tokens: true,
        token_id: null,
        block: 20_000_000
      }
    ]
  };
  return { source, calls };
}

describe('buildIdentityExport', () => {
  let clock = 1_000;
  const options = {
    bulkThreshold: 2,
    extraProfileIds: [WAVER.toUpperCase(), P('beef')],
    includeDelegations: true,
    freezeMs: Date.UTC(2026, 10, 24),
    exporterRevision: 'a'.repeat(40),
    now: () => clock++
  };

  it('exports the identities in scope with their labels, in order', async () => {
    const doc = await buildIdentityExport(world().source, options);
    expect(
      doc.identities.map((it) => [it.profile_id, it.handle, it.scope])
    ).toEqual([
      [P3, `id-${W(5)}`, ['rating']],
      [WAVER, `id-${W(8)}`, ['waves']],
      [TAGGER, 'tagger', ['handle', 'rating']],
      [ALICE, 'Alice', ['handle', 'rating']],
      [null, null, ['wallets']]
    ]);
  });

  it('keeps 6529.io values as stored and the wallets ascending', async () => {
    const doc = await buildIdentityExport(world().source, options);
    const alice = doc.identities.find((it) => it.profile_id === ALICE)!;
    expect(alice).toEqual({
      profile_id: ALICE,
      handle: 'Alice',
      normalised_handle: 'alice',
      primary_address: W(1),
      wallets: [W(1)],
      consolidation_key: W(1),
      classification: 'PSEUDONYM',
      sub_classification: null,
      pfp: 'ipfs://pfp',
      banner1: null,
      banner2: null,
      website: 'https://example.org',
      statements: [
        {
          id: 'st-1',
          statement_group: 'GENERAL',
          statement_type: 'BIO',
          statement_value: 'hello',
          statement_comment: 'c',
          created_at_ms: Date.UTC(2024, 0, 1)
        },
        {
          id: 'st-2',
          statement_group: 'SOCIAL_MEDIA_ACCOUNT',
          statement_type: 'X',
          statement_value: 'alice',
          statement_comment: null,
          created_at_ms: Date.UTC(2024, 0, 2)
        }
      ],
      tdh: 1000.5,
      xtdh: 12.75,
      rep: 30,
      cic: 5,
      level: 6,
      level_raw: 1043.25,
      scope: ['handle', 'rating']
    });
    const pair = doc.identities.find((it) => it.profile_id === null)!;
    expect(pair.wallets).toEqual([W(6), W(7)]);
    expect(pair.handle).toBeNull();
    expect(pair.website).toBeNull();
  });

  it('exports every rating between exported profiles, bulk or not', async () => {
    const doc = await buildIdentityExport(world().source, options);
    expect(
      doc.ratings.map((it) => [
        it.rater_profile_id,
        it.matter,
        it.target_profile_id,
        it.category,
        it.rating
      ])
    ).toEqual([
      [P3, 'CIC', ALICE, '', 20],
      [TAGGER, 'REP', ALICE, 'Holder', 1],
      [ALICE, 'REP', P3, 'Good Person', -5]
    ]);
    expect(doc.bulk_rep).toEqual([
      {
        profile_id: TAGGER,
        direction: 'outgoing',
        category: 'Holder',
        contributor_count: 3
      }
    ]);
    expect(doc.stats).toEqual(
      expect.objectContaining({
        identities: 5,
        ratings: 3,
        bulk_categories: 1,
        bulk_ratings_left_out: 2,
        profiles_left_out: 2
      })
    );
  });

  it('writes the header, the reserved handles and the notes', async () => {
    clock = 1_000;
    const doc = await buildIdentityExport(world().source, options);
    expect(doc.format).toBe('6529.identity-export.v1');
    expect(doc.source).toBe('database');
    expect(doc.exporter_revision).toBe('a'.repeat(40));
    expect(doc.started_at_ms).toBe(1_000);
    expect(doc.finished_at_ms).toBeGreaterThan(doc.started_at_ms);
    expect(doc.freeze_ms).toBe(Date.UTC(2026, 10, 24));
    expect(doc.tdh_block).toBe(24_000_000);
    expect(doc.reserved_handles).toEqual(reservedHandles());
    expect(doc.reserved_handles.length).toBeGreaterThan(100);
    expect(doc.reserved_handles).toContain('admin');
    expect(doc.delegations).toHaveLength(1);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('1 waves-list profile ids'),
        expect.stringContaining('1 profiles named by ratings'),
        expect.stringContaining('1 given REP categories with more than 2')
      ])
    );
  });

  it('with the bulk rule off, brings in every rated placeholder', async () => {
    const doc = await buildIdentityExport(world().source, {
      ...options,
      bulkThreshold: 0
    });
    const ids = doc.identities.map((it) => it.profile_id);
    expect(ids).toEqual(expect.arrayContaining([P1, P2]));
    expect(doc.ratings).toHaveLength(5);
    expect(doc.bulk_rep).toEqual([]);
  });

  it('leaves the delegations out when asked', async () => {
    const doc = await buildIdentityExport(world().source, {
      ...options,
      includeDelegations: false
    });
    expect(doc.delegations).toEqual([]);
  });
});

describe('reservedHandles', () => {
  it('is lowercase, unique and ascending', () => {
    const handles = reservedHandles();
    expect(handles).toEqual(
      Array.from(new Set(handles.map((it) => it.toLowerCase()))).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    );
  });
});

describe('values as the public API shows them', () => {
  it('reads an unset or unknown classification as PSEUDONYM', () => {
    expect(shownClassification(null)).toBe('PSEUDONYM');
    expect(shownClassification('SOMETHING_ELSE')).toBe('PSEUDONYM');
    expect(shownClassification('ORGANIZATION')).toBe('ORGANIZATION');
  });

  it('reads statements of real handles only, and notes a missing waves list', async () => {
    const { source } = world();
    const asked: string[][] = [];
    const statementsByProfileIds = source.statementsByProfileIds;
    source.statementsByProfileIds = async (ids) => {
      asked.push(ids);
      return statementsByProfileIds(ids);
    };
    const doc = await buildIdentityExport(source, {
      bulkThreshold: 2,
      extraProfileIds: [],
      wavesListGiven: false,
      includeDelegations: false,
      freezeMs: null,
      exporterRevision: 'a'.repeat(40)
    });
    expect(asked.flat().sort()).toEqual([ALICE, TAGGER].sort());
    expect(doc.notes[0]).toContain('no --extra-ids');
  });
});
