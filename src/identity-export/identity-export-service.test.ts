import {
  IdentityExportSource,
  IdentityRow,
  StatementRow
} from './identity-export.db';
import {
  buildIdentityExport,
  freezeDayProblem,
  HELP_BOT_CREDIT_RULE_NOTE,
  exportRules,
  identitySyncProblem,
  readinessProblems,
  tdhBlockTimingProblem,
  leaveOutHelpBotCredits,
  repMismatches,
  reservedHandles,
  shownClassification,
  TDH_NOTE,
  toExportIdentity,
  withFileRep,
  withoutCredits
} from './identity-export.service';
import { IdentityExportNotReadyError } from './identity-export.errors';
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
const BOT = P('b07');
const FREEZE = Date.UTC(2026, 10, 24);

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
    latestTdhBlock: async () => ({
      block: 24_000_000,
      timestampMs: FREEZE - 12_000
    }),
    overCreditRaters: async () => ({ withXtdh: 0, tdhOnly: 0 }),
    ratingEditsSince: async () => 0,
    ratingsChangedSince: async () => 0,
    identitySyncProgress: async () => ({
      pendingGeneration: 5,
      pendingBlock: 24_000_000,
      syncedGeneration: 5,
      fullWriteBlock: 24_000_000
    }),
    helpBotProfileId: async () => BOT,
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

  it("keeps 6529.io values as stored, the wallets ascending, and the chain's level", async () => {
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
      // The file's REP to Alice (TAGGER's 1, not the stored 30) + TDH: as the
      // chain counts it; 6529.io's 1043.25 also counts the xTDH.
      rep: 1,
      cic: 5,
      level: 6,
      level_raw: 1 + 1000.5,
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

  it('gives each profile with a site its cms value, and notes the rest', async () => {
    const site = { primary: { publication: 'bafk1', package: 'bafk2' } };
    const doc = await buildIdentityExport(world().source, {
      ...options,
      cmsFields: { [ALICE]: site, [P('dead')]: { archive: 'bafk3' } }
    });
    expect(doc.identities.find((it) => it.profile_id === ALICE)?.cms).toEqual(
      site
    );
    expect(
      doc.identities
        .filter((it) => it.cms !== undefined)
        .map((it) => it.profile_id)
    ).toEqual([ALICE]);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        'cms: 1 identities carry a profile site value',
        `cms: 1 profiles with a profile site value are not in the export: ${P('dead')}`
      ])
    );
    const without = await buildIdentityExport(world().source, options);
    expect(without.identities.some((it) => 'cms' in it)).toBe(false);
  });

  it("leaves the help bot's credits out, and out of rep and level", async () => {
    const { source } = world();
    const edges = await source.ratingEdges();
    const credit = (target: string, rating: number) => ({
      rater_profile_id: TAGGER,
      target_profile_id: target,
      matter: 'REP' as const,
      category: 'Help6529 Credits',
      rating,
      last_modified_ms: 1
    });
    const doc = await buildIdentityExport(
      {
        ...source,
        ratingEdges: async () => [
          ...edges,
          credit(ALICE, 5),
          credit(ALICE.toUpperCase(), 2)
        ]
      },
      options
    );
    expect(doc.ratings.some((it) => it.category === 'Help6529 Credits')).toBe(
      false
    );
    const alice = doc.identities.find((it) => it.profile_id === ALICE)!;
    // The file's REP: the credits are not in it.
    expect(alice.rep).toBe(1);
    expect(alice.level_raw).toBe(1 + 1000.5);
    expect(doc.stats.help_bot_credits_left_out).toBe(2);
    expect(doc.stats.help_bot_credit_profiles).toBe(1);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('help-bot credits left out: 2 REP ratings')
      ])
    );
  });

  it('matches the help-bot category whatever its case or surrounding spaces', () => {
    const edge = (category: string) => ({
      rater_profile_id: TAGGER,
      target_profile_id: ALICE,
      matter: 'REP',
      category,
      rating: 1
    });
    const { edges, credits } = leaveOutHelpBotCredits([
      edge('Help6529 Credits'),
      edge(' help6529 credits '),
      edge('HELP6529 CREDITS'),
      edge('Help6529 Credits extra'),
      { ...edge('Help6529 Credits'), matter: 'CIC' }
    ]);
    expect(edges.map((it) => [it.matter, it.category])).toEqual([
      ['REP', 'Help6529 Credits extra'],
      ['CIC', 'Help6529 Credits']
    ]);
    expect(credits.ratings).toBe(3);
    expect(credits.byTarget.get(ALICE)).toBe(3);
  });

  it('makes no bulk category of the credits and brings no one in by them', async () => {
    const { source } = world();
    const edges = await source.ratingEdges();
    const credit = (target: string) => ({
      rater_profile_id: BOT,
      target_profile_id: target,
      matter: 'REP' as const,
      category: 'Help6529 Credits',
      rating: 10,
      last_modified_ms: 1
    });
    const doc = await buildIdentityExport(
      {
        ...source,
        ratingEdges: async () => [...edges, ...[P1, P2, P3, ALICE].map(credit)]
      },
      options
    );
    expect(doc.bulk_rep.map((it) => it.profile_id)).toEqual([TAGGER]);
    const ids = doc.identities.map((it) => it.profile_id);
    expect(ids).not.toContain(P1);
    expect(ids).not.toContain(P2);
    expect(ids).not.toContain(BOT);
    expect(doc.stats.help_bot_credits_left_out).toBe(4);
    expect(doc.stats.help_bot_credits_from_others).toBe(0);
  });

  it('takes nothing from anyone for credits given to a profile not exported', async () => {
    const { source } = world();
    const edges = await source.ratingEdges();
    const plain = await buildIdentityExport(source, options);
    const doc = await buildIdentityExport(
      {
        ...source,
        ratingEdges: async () => [
          ...edges,
          {
            rater_profile_id: TAGGER,
            target_profile_id: P1,
            matter: 'REP' as const,
            category: 'Help6529 Credits',
            rating: 9,
            last_modified_ms: 1
          }
        ]
      },
      options
    );
    expect(doc.identities).toEqual(plain.identities);
    expect(doc.ratings).toEqual(plain.ratings);
    expect(doc.stats.help_bot_credit_profiles).toBe(1);
  });

  it('always states the credit rule and the TDH it writes', async () => {
    const doc = await buildIdentityExport(world().source, options);
    expect(doc.stats.help_bot_credits_left_out).toBe(0);
    expect(doc.notes).toEqual(
      expect.arrayContaining([HELP_BOT_CREDIT_RULE_NOTE, TDH_NOTE])
    );
    expect(HELP_BOT_CREDIT_RULE_NOTE).toContain(
      'left out of ratings, bulk_rep, rep, level_raw and level'
    );
  });

  it("counts credits from a rater that isn't the help bot", async () => {
    const { source } = world();
    const edges = await source.ratingEdges();
    const credit = (rater: string) => ({
      rater_profile_id: rater,
      target_profile_id: ALICE,
      matter: 'REP' as const,
      category: 'Help6529 Credits',
      rating: 1,
      last_modified_ms: 1
    });
    const doc = await buildIdentityExport(
      {
        ...source,
        ratingEdges: async () => [
          ...edges,
          credit(BOT.toUpperCase()),
          credit(TAGGER)
        ]
      },
      options
    );
    expect(doc.stats.help_bot_credits_left_out).toBe(2);
    expect(doc.stats.help_bot_credits_from_others).toBe(1);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "1 ratings in the help bot's category come from a rater that is not the help bot's profile"
        )
      ])
    );
  });

  it('counts stored reps that are not the sum of the REP ratings read, without failing', async () => {
    // Alice: 30 stored, 1 rated; P3: 0 stored, -5 rated.
    const doc = await buildIdentityExport(world().source, options);
    expect(doc.stats.rep_mismatch).toBe(2);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '2 exported profiles have a stored rep that is not the sum of their REP ratings read'
        )
      ])
    );
    const alice = toExportIdentity(
      identity(W(1), { id: ALICE, handle: 'Alice' }, { rep: 8 }),
      [W(1)],
      [],
      ['handle']
    );
    const edges = [
      rating(TAGGER, ALICE, 'REP', 'Holder', 3),
      rating(BOT, ALICE, 'REP', 'Help6529 Credits', 5),
      rating(TAGGER, ALICE, 'CIC', '', 100)
    ];
    // Credits count: 6529.io's rep includes them.
    expect(repMismatches([alice], edges)).toBe(0);
    expect(repMismatches([{ ...alice, rep: 3 }], edges)).toBe(1);
  });

  it("writes the identities sync's state into stats, and notes a sync behind", async () => {
    const synced = await buildIdentityExport(world().source, options);
    expect(synced.stats).toEqual(
      expect.objectContaining({
        identity_sync_pending_generation: 5,
        identity_sync_synced_generation: 5,
        identity_sync_pending_block: 24_000_000
      })
    );
    expect(synced.notes.some((it) => it.startsWith('not a finished'))).toBe(
      false
    );
    const { source } = world();
    const behind = await buildIdentityExport(
      {
        ...source,
        identitySyncProgress: async () => ({
          pendingGeneration: 6,
          pendingBlock: 24_000_000,
          syncedGeneration: 5,
          fullWriteBlock: 24_000_000
        })
      },
      options
    );
    expect(behind.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'not a finished TDH day: the identities sync is behind'
        )
      ])
    );
    expect(freezeDayProblem(behind, 24_000_000)).toContain('behind');
  });

  it('writes the rules it was written by, for the builder to check', async () => {
    const doc = await buildIdentityExport(world().source, options);
    expect(doc.format).toBe('6529.identity-export.v1');
    expect(doc.rules).toEqual({
      help_bot_credit_category: 'Help6529 Credits',
      help_bot_credit_match: 'trim_casefold',
      help_bot_credits: 'excluded',
      rep: 'sum_of_file_ratings',
      level: 'rep+tdh',
      tdh: 'boosted',
      xtdh: 'as_stored',
      bulk_threshold: 2
    });
    expect(doc.rules).toEqual(exportRules(options.bulkThreshold));
    expect(doc.tdh_block_timestamp_ms).toBe(FREEZE - 12_000);
  });

  it('refuses another day before the long reads, and goes on with the right one', async () => {
    const { source } = world();
    const ratingEdges = jest.fn(source.ratingEdges);
    const realHandleProfileIds = jest.fn(source.realHandleProfileIds);
    const behind = {
      ...source,
      ratingEdges,
      realHandleProfileIds,
      identitySyncProgress: async () => ({
        pendingGeneration: 6,
        pendingBlock: 24_000_000,
        syncedGeneration: 5
      })
    };
    await expect(
      buildIdentityExport(behind, { ...options, expectTdhBlock: 24_000_000 })
    ).rejects.toThrow(IdentityExportNotReadyError);
    await expect(
      buildIdentityExport(
        { ...source, ratingEdges, realHandleProfileIds },
        { ...options, expectTdhBlock: 23_999_000 }
      )
    ).rejects.toThrow("6529.io's latest TDH block is 24000000, not 23999000");
    expect(ratingEdges).not.toHaveBeenCalled();
    expect(realHandleProfileIds).not.toHaveBeenCalled();
    const doc = await buildIdentityExport(source, {
      ...options,
      expectTdhBlock: 24_000_000
    });
    expect(doc.tdh_block).toBe(24_000_000);
  });

  it('refuses a TDH block not taken in the hour before the freeze', async () => {
    const at = (timestampMs: number | null) =>
      tdhBlockTimingProblem({ block: 7, timestampMs }, FREEZE);
    expect(at(FREEZE)).toBeNull();
    expect(at(FREEZE - 12_000)).toBeNull();
    expect(at(FREEZE - 3_600_000 + 1)).toBeNull();
    expect(at(FREEZE - 3_600_000)).toContain('not of the hour before');
    expect(at(FREEZE + 1)).toContain('not of the hour before');
    expect(at(FREEZE - 86_400_000)).toContain('2026-11-23T00:00:00.000Z');
    expect(at(null)).toBe('the TDH block has no timestamp');
    const { source } = world();
    const ratingEdges = jest.fn(source.ratingEdges);
    await expect(
      buildIdentityExport(
        {
          ...source,
          ratingEdges,
          latestTdhBlock: async () => ({
            block: 24_000_000,
            timestampMs: FREEZE - 86_400_000
          })
        },
        options
      )
    ).rejects.toThrow(IdentityExportNotReadyError);
    expect(ratingEdges).not.toHaveBeenCalled();
    // A rehearsal has no freeze time to hold it to.
    const rehearsal = await buildIdentityExport(
      {
        ...source,
        latestTdhBlock: async () => ({ block: 1, timestampMs: 0 })
      },
      { ...options, freezeMs: null }
    );
    expect(rehearsal.tdh_block).toBe(1);
  });

  it('refuses raters over credit and changes after the freeze unless acknowledged', async () => {
    const { source } = world();
    const ratingEditsSince = jest.fn(async () => 2);
    const ratingsChangedSince = jest.fn(async () => 4);
    const busy = {
      ...source,
      overCreditRaters: async () => ({ withXtdh: 3, tdhOnly: 5 }),
      ratingEditsSince,
      ratingsChangedSince
    };
    const atFreeze = { ...options, expectTdhBlock: 24_000_000 };
    const refused = (opts: {
      acceptOverCredit?: number;
      acceptEditsAfterFreeze?: number;
    }) =>
      buildIdentityExport(busy, { ...atFreeze, ...opts }).then(
        () => null,
        (error: IdentityExportNotReadyError) => error
      );
    const all = await refused({});
    expect(all?.causes).toEqual([
      'over_credit',
      'after_freeze',
      'after_freeze'
    ]);
    expect(all?.exitCode).toBe(4);
    expect(all?.message).toContain(
      '3 raters give more REP or CIC than their credit'
    );
    const after = await refused({ acceptOverCredit: 3 });
    expect(after?.exitCode).toBe(5);
    expect(after?.message).toContain(
      '2 REP and CIC rating edits were logged after the freeze'
    );
    expect(after?.message).toContain(
      '4 REP and CIC ratings were changed after the freeze'
    );
    const changed = await refused({
      acceptOverCredit: 3,
      acceptEditsAfterFreeze: 2
    });
    expect(changed?.causes).toEqual(['after_freeze']);
    expect(changed?.message).toContain(
      '--accept-ratings-changed-after-freeze 4'
    );
    const doc = await buildIdentityExport(busy, {
      ...atFreeze,
      acceptOverCredit: 3,
      acceptEditsAfterFreeze: 2,
      acceptRatingsChangedAfterFreeze: 4
    });
    expect(ratingEditsSince).toHaveBeenCalledWith(FREEZE);
    expect(ratingsChangedSince).toHaveBeenCalledWith(FREEZE);
    expect(doc.stats).toEqual(
      expect.objectContaining({
        over_credit_raters: 3,
        over_credit_raters_tdh_only: 5,
        rating_edits_after_freeze: 2,
        ratings_modified_after_freeze: 4
      })
    );
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '3 raters give more REP or CIC than their credit as 6529.io counts it (TDH + xTDH), 5 by TDH alone'
        ),
        expect.stringContaining('2 REP and CIC rating edits were logged'),
        expect.stringContaining(
          '4 REP and CIC ratings were changed after the freeze'
        )
      ])
    );
    // Without a freeze time (a rehearsal) they are only counted.
    const counted = await buildIdentityExport(busy, {
      ...options,
      freezeMs: null
    });
    expect(counted.stats.over_credit_raters).toBe(3);
    expect(counted.stats.rating_edits_after_freeze).toBe(0);
    expect(counted.stats.ratings_modified_after_freeze).toBe(0);
    expect(
      readinessProblems(
        {
          tdh: { block: 24_000_000, timestampMs: FREEZE },
          identitySync: null,
          overCredit: { withXtdh: 0, tdhOnly: 0 },
          editsAfterFreeze: 0,
          ratingsChangedAfterFreeze: 0
        },
        { freezeMs: FREEZE, expectTdhBlock: 24_000_000 }
      )
    ).toEqual([
      {
        cause: 'day',
        message:
          "the identities sync's state (identity_tdh_sync_state) could not be read"
      }
    ]);
  });

  it('exits 3 first: the day before over credit and changes', () => {
    const error = new IdentityExportNotReadyError([
      { cause: 'after_freeze', message: 'a' },
      { cause: 'day', message: 'b' }
    ]);
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe('a; b');
    expect(new IdentityExportNotReadyError('c').exitCode).toBe(3);
  });

  it("counts reps the file's own ratings don't add up to", async () => {
    const { source } = world();
    const edges = await source.ratingEdges();
    // Alice's stored 5 is TAGGER's 1 and a profile with no identity's 4;
    // P3's -5 is Alice's: every stored rep adds up to the ratings read.
    const doc = await buildIdentityExport(
      {
        ...source,
        ratingEdges: async () => [
          ...edges,
          rating(GHOST, ALICE, 'REP', 'Good Person', 4)
        ],
        identitiesByProfileIds: async (ids) =>
          (await source.identitiesByProfileIds(ids)).map((it) =>
            it.p_external_id === ALICE
              ? { ...it, rep: 5 }
              : it.p_external_id === P3
                ? { ...it, rep: -5 }
                : it
          )
      },
      options
    );
    expect(doc.stats.rep_mismatch).toBe(0);
    expect(doc.stats.rep_differs_from_file_ratings).toBe(1);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '1 exported profiles have a stored rep (help-bot credits aside) that is not the sum of the REP ratings to them in this file'
        )
      ])
    );
    // The file's rep and level: TAGGER's 1, not the stored 5.
    const alice = doc.identities.find((it) => it.profile_id === ALICE)!;
    expect([alice.rep, alice.level_raw]).toEqual([1, 1 + 1000.5]);
  });

  it("writes each identity's rep and level from the file's REP ratings", () => {
    const base = toExportIdentity(
      identity(W(1), { id: ALICE, handle: 'Alice' }, { rep: 900, tdh: 95 }),
      [W(1)],
      [],
      ['handle']
    );
    const pair = toExportIdentity(
      identity(`${W(6)}-${W(7)}`, null, { rep: 3, tdh: 10 }),
      [W(6), W(7)],
      [],
      ['wallets']
    );
    const [alice, noProfile] = withFileRep(
      [base, pair],
      [
        rating(TAGGER, ALICE, 'REP', 'Holder', 8),
        rating(P3, ALICE, 'REP', 'Good Person', -3),
        rating(P3, ALICE, 'CIC', '', 50)
      ]
    );
    expect([alice.rep, alice.level_raw, alice.level]).toEqual([5, 100, 3]);
    expect([noProfile.rep, noProfile.level_raw]).toEqual([0, 10]);
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

describe("the chain's level", () => {
  const row = (rep: number, tdh: number, xtdh: number) =>
    identity(
      W(1),
      { id: ALICE, handle: 'Alice' },
      {
        rep,
        tdh,
        xtdh,
        level_raw: rep + tdh + xtdh
      }
    );

  it('drops a level when the xTDH no longer counts', () => {
    // 6529.io: 990 + 20 = 1010, level 6; the chain: 990, level 5.
    const it = toExportIdentity(row(0, 990, 20), [W(1)], [], ['handle']);
    expect(it.level_raw).toBe(990);
    expect(it.level).toBe(5);
    expect(it.xtdh).toBe(20);
  });

  it('drops a level when the credits no longer count', () => {
    const it = toExportIdentity(row(10, 1000, 5), [W(1)], [], ['handle']);
    expect([it.level_raw, it.level]).toEqual([1010, 6]);
    const [credited] = withoutCredits([it], {
      byTarget: new Map([[ALICE, 11]]),
      ratings: 1
    });
    expect([credited.rep, credited.level_raw, credited.level]).toEqual([
      -1, 999, 5
    ]);
    // Exactly at the boundary stays at the level.
    const [atBoundary] = withoutCredits([it], {
      byTarget: new Map([[ALICE, 10]]),
      ratings: 1
    });
    expect([atBoundary.level_raw, atBoundary.level]).toEqual([1000, 6]);
  });
});

describe('the freeze day check', () => {
  const caughtUp = {
    pendingGeneration: 5,
    pendingBlock: 100,
    syncedGeneration: 5,
    fullWriteBlock: 100
  };

  it('passes only a TDH block whose identities sync has finished', () => {
    expect(identitySyncProblem(100, caughtUp)).toBeNull();
    expect(identitySyncProblem(100, { ...caughtUp, syncedGeneration: 4 })).toBe(
      'the identities sync is behind: generation 4 synced, 5 pending'
    );
    expect(identitySyncProblem(101, caughtUp)).toBe(
      'the last TDH write is of block 100, not the TDH block 101'
    );
    expect(identitySyncProblem(100, null)).toContain('could not be read');
    // Only a partial write has reached block 100.
    expect(identitySyncProblem(100, { ...caughtUp, fullWriteBlock: 99 })).toBe(
      "the last full TDH write is of block 99, not 100: the day's full TDH run hasn't been written yet"
    );
    expect(
      identitySyncProblem(100, { ...caughtUp, fullWriteBlock: null })
    ).toContain('of block none');
  });

  it('refuses another TDH block, or one not synced yet', () => {
    expect(
      freezeDayProblem({ tdh_block: 100, identity_sync: caughtUp }, 100)
    ).toBeNull();
    expect(
      freezeDayProblem({ tdh_block: 100, identity_sync: caughtUp }, 99)
    ).toBe("6529.io's latest TDH block is 100, not 99");
    expect(
      freezeDayProblem(
        {
          tdh_block: 100,
          identity_sync: { ...caughtUp, pendingGeneration: 6 }
        },
        100
      )
    ).toContain('behind');
  });
});
