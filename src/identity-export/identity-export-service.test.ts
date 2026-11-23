import {
  IdentityExportSource,
  IdentityRow,
  StatementRow
} from './identity-export.db';
import {
  acceptName,
  acknowledgementProblem,
  buildIdentityExport,
  cicMismatches,
  overCreditInFile,
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
const NO_PROFILE_WRITES = {
  handle: 0,
  classification: 0,
  pfp: 0,
  banner: 0,
  statements: 0,
  archived: 0,
  saves: 0,
  created: 0
};

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
    ratingsChangedSince: async () => [],
    profileWritesSince: async () => NO_PROFILE_WRITES,
    rowsAfterBlock: async () => ({
      consolidations: 0,
      delegations: 0,
      primaryAddressDelegations: 0
    }),
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

  it("keeps 6529.io values as stored, the wallets ascending, and level from the file's ratings", async () => {
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
      // 6529.io's own, as stored.
      io_rep: 30,
      io_level_raw: 1043.25,
      io_level: 6,
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
      help_bot_credit_match: 'js_trim_then_to_lower_case',
      help_bot_credits: 'excluded',
      rep: 'sum_of_file_ratings',
      cic: 'as_stored',
      level: 'rep+tdh',
      level_table: '6529.io levels, capped at 100',
      tdh: 'boosted',
      xtdh: 'as_stored',
      bulk_threshold: 2,
      cms_fields_sha256: null,
      delegations: 'through_tdh_block'
    });
    expect(doc.rules).toEqual(exportRules(options.bulkThreshold));
    expect(doc.tdh_block_timestamp_ms).toBe(FREEZE - 12_000);
  });

  it('refuses another day, with every reason, and goes on with the right one', async () => {
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
    const behindError = await buildIdentityExport(behind, {
      ...options,
      expectTdhBlock: 24_000_000
    }).then(
      () => null,
      (error: IdentityExportNotReadyError) => error
    );
    // The day, and the file's own counts: all in one run.
    expect(behindError?.causes).toEqual([
      'day',
      'over_credit',
      'missing_extra_ids'
    ]);
    expect(behindError?.exitCode).toBe(3);
    expect(behindError?.message).toContain('the identities sync is behind');
    expect(behindError?.message).toContain('--accept-over-credit 2');
    expect(behindError?.message).toContain('--accept-missing-extra-ids 1');
    await expect(
      buildIdentityExport(
        { ...source, ratingEdges, realHandleProfileIds },
        { ...options, expectTdhBlock: 23_999_000 }
      )
    ).rejects.toThrow("6529.io's latest TDH block is 24000000, not 23999000");
    expect(ratingEdges).toHaveBeenCalled();
    expect(realHandleProfileIds).toHaveBeenCalled();
    const doc = await buildIdentityExport(source, {
      ...options,
      expectTdhBlock: 24_000_000,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 1
    });
    expect(doc.tdh_block).toBe(24_000_000);
  });

  it('refuses a TDH block not taken in the hour before the freeze', async () => {
    const at = (timestampMs: number | null) =>
      tdhBlockTimingProblem({ block: 7, timestampMs }, FREEZE);
    expect(at(FREEZE)).toBeNull();
    expect(at(FREEZE - 12_000)).toBeNull();
    expect(at(FREEZE - 600_000 + 1)).toBeNull();
    expect(at(FREEZE - 600_000)).toContain('not of the 10 minutes before');
    expect(at(FREEZE - 3_600_000)).toContain('not of the 10 minutes before');
    expect(at(FREEZE + 1)).toContain('not of the 10 minutes before');
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

  it('refuses, with every reason, unless each count is acknowledged exactly', async () => {
    const { source } = world();
    const changed = [1, 2, 3, 4].map((n) => ({
      rater_profile_id: ALICE,
      target_profile_id: P(String(n)),
      matter: 'REP',
      category: 'Late',
      rating: n,
      last_modified_ms: FREEZE + n
    }));
    const ratingEditsSince = jest.fn(async () => 2);
    const ratingsChangedSince = jest.fn(async () => changed);
    const ratingEdges = jest.fn(source.ratingEdges);
    const busy = {
      ...source,
      overCreditRaters: async () => ({ withXtdh: 3, tdhOnly: 5 }),
      ratingEditsSince,
      ratingsChangedSince,
      ratingEdges
    };
    const atFreeze = { ...options, expectTdhBlock: 24_000_000 };
    // In the file, P3 gives CIC 20 and TAGGER REP 1 with TDH 0: over the
    // chain's cap. One waves-list id has no identity.
    const exact = {
      acceptEditsAfterFreeze: 2,
      acceptRatingsChangedAfterFreeze: 4,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 1
    };
    const refused = (acks: Partial<typeof exact>) =>
      buildIdentityExport(busy, { ...atFreeze, ...acks }).then(
        () => null,
        (error: IdentityExportNotReadyError) => error
      );
    const all = await refused({});
    expect(all?.causes).toEqual([
      'after_freeze',
      'after_freeze',
      'over_credit',
      'missing_extra_ids'
    ]);
    expect(all?.exitCode).toBe(4);
    expect(all?.message).toContain(
      '2 REP and CIC rating edits were logged after the freeze'
    );
    expect(all?.message).toContain('--accept-ratings-changed-after-freeze 4');
    expect(all?.message).toContain(
      "2 raters give more REP or CIC in this file than floor(TDH) of their identity, the chain's cap"
    );
    expect(all?.message).toContain('--accept-missing-extra-ids 1');
    expect(ratingEdges).toHaveBeenCalled();
    // More than the count is refused too.
    const tooMany = await refused({ ...exact, acceptOverCredit: 3 });
    expect(tooMany?.causes).toEqual(['over_credit']);
    expect(tooMany?.message).toContain(
      '--accept-over-credit 3 does not match: 2 raters'
    );
    expect(
      (await refused({ ...exact, acceptMissingExtraIds: 0 }))?.exitCode
    ).toBe(6);
    const doc = await buildIdentityExport(busy, { ...atFreeze, ...exact });
    expect(ratingEditsSince).toHaveBeenCalledWith(FREEZE);
    expect(ratingsChangedSince).toHaveBeenCalledWith(FREEZE);
    expect(doc.acknowledged).toEqual({
      over_credit: 2,
      edits_after_freeze: 2,
      ratings_changed_after_freeze: 4,
      profile_writes_after_freeze: 0,
      consolidations_after_freeze: 0,
      missing_extra_ids: 1,
      unmatched_cms: 0,
      no_extra_ids: false,
      no_cms_fields: false,
      bulk: null
    });
    expect(doc.ratings_changed_after_freeze).toEqual(changed);
    expect(doc.stats).toEqual(
      expect.objectContaining({
        over_credit_raters_in_file: 2,
        over_credit_raters: 3,
        over_credit_raters_tdh_only: 5,
        rating_edits_after_freeze: 2,
        ratings_modified_after_freeze: 4,
        extra_ids_missing: 1
      })
    );
    // Without a freeze time (a rehearsal) they are only counted.
    const counted = await buildIdentityExport(busy, {
      ...options,
      freezeMs: null
    });
    expect(counted.stats.over_credit_raters_in_file).toBe(2);
    expect(counted.stats.rating_edits_after_freeze).toBe(0);
    expect(counted.ratings_changed_after_freeze).toEqual([]);
    expect(counted.acknowledged.over_credit).toBe(0);
    expect(
      readinessProblems(
        {
          tdh: { block: 24_000_000, timestampMs: FREEZE },
          identitySync: null,
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

  it('refuses profile writes after the freeze, by kind, unless acknowledged exactly', async () => {
    const { source } = world();
    const profileWritesSince = jest.fn(async () => ({
      ...NO_PROFILE_WRITES,
      handle: 1,
      statements: 2,
      // Saves logged or not: a pfp update writes no activity log.
      saves: 2,
      created: 1
    }));
    const busy = { ...source, profileWritesSince };
    const atFreeze = {
      ...options,
      expectTdhBlock: 24_000_000,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 1
    };
    const refused = await buildIdentityExport(busy, atFreeze).then(
      () => null,
      (error: IdentityExportNotReadyError) => error
    );
    expect(refused?.causes).toEqual(['after_freeze']);
    expect(refused?.message).toContain(
      '6 profile writes were made after the freeze: logged, saved to profiles_archive, or profiles created (by kind in stats); acknowledge with --accept-profile-writes-after-freeze 6'
    );
    expect(profileWritesSince).toHaveBeenCalledWith(FREEZE);
    const doc = await buildIdentityExport(busy, {
      ...atFreeze,
      acceptProfileWritesAfterFreeze: 6
    });
    expect(doc.acknowledged.profile_writes_after_freeze).toBe(6);
    expect(doc.stats).toEqual(
      expect.objectContaining({
        profile_writes_after_freeze: 6,
        profile_saves_after_freeze: 2,
        profile_handle_edits_after_freeze: 1,
        profile_statement_edits_after_freeze: 2,
        profiles_created_after_freeze: 1,
        profile_pfp_edits_after_freeze: 0
      })
    );
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        'profile writes after the freeze: 1 handle, 0 classification, 0 pfp, 0 banner, 2 statement, 0 archiving logged; 2 profile rows saved to profiles_archive (every save, logged or not); 1 profiles created'
      ])
    );
    // A rehearsal doesn't read them.
    profileWritesSince.mockClear();
    await buildIdentityExport(busy, { ...options, freezeMs: null });
    expect(profileWritesSince).not.toHaveBeenCalled();
  });

  it('takes consolidations and primary addresses after the TDH block up to the ceiling acknowledged, and records the exact counts', async () => {
    const { source } = world();
    const rowsAfterBlock = jest.fn(async () => ({
      consolidations: 1,
      delegations: 5,
      primaryAddressDelegations: 1
    }));
    const busy = { ...source, rowsAfterBlock };
    const atFreeze = {
      ...options,
      expectTdhBlock: 24_000_000,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 1
    };
    const run = (extra: Record<string, unknown>) =>
      buildIdentityExport(busy, { ...atFreeze, ...extra }).then(
        (doc) => doc,
        (error: IdentityExportNotReadyError) => error
      );
    const refused = (await run({})) as IdentityExportNotReadyError;
    expect(refused.causes).toEqual(['after_freeze']);
    expect(refused.exitCode).toBe(5);
    expect(refused.message).toContain(
      '2 consolidation rows and primary-address delegations have a block after the TDH block, and the delegations loop has applied them to the identities (by table in stats); acknowledge them with --accept-consolidations-after-freeze 2: a ceiling, so a higher number also passes if more may come before the next run (the file records the exact count)'
    );
    expect(rowsAfterBlock).toHaveBeenCalledWith(24_000_000);
    const under = (await run({
      acceptConsolidationsAfterFreeze: 1
    })) as IdentityExportNotReadyError;
    expect(under.causes).toEqual(['after_freeze']);
    // A ceiling: the exact count, or more.
    for (const ceiling of [2, 5]) {
      const doc = (await run({
        acceptConsolidationsAfterFreeze: ceiling
      })) as Awaited<ReturnType<typeof buildIdentityExport>>;
      expect(doc.acknowledged.consolidations_after_freeze).toBe(ceiling);
      expect(doc.stats).toEqual(
        expect.objectContaining({
          consolidations_after_tdh_block: 1,
          primary_address_delegations_after_tdh_block: 1,
          delegations_after_tdh_block: 5
        })
      );
      expect(doc.notes).toEqual(
        expect.arrayContaining([
          "after the TDH block 24000000: 1 consolidation rows and 1 primary-address delegations, which the delegations loop has applied to the identities (a consolidation by a partial TDH write; a revoked confirmed pair leaves a one-way row at the revocation's block, so it is counted), and 5 delegations rows in all, which the file leaves out. A delegation revoked after the TDH block is not counted: the loop deletes its row, so it is missing from the file"
        ])
      );
    }
    // Delegations after the TDH block alone are only recorded.
    const onlyDelegations = await buildIdentityExport(
      {
        ...source,
        rowsAfterBlock: async () => ({
          consolidations: 0,
          delegations: 7,
          primaryAddressDelegations: 0
        })
      },
      atFreeze
    );
    expect(onlyDelegations.stats.delegations_after_tdh_block).toBe(7);
    // A rehearsal doesn't count them.
    rowsAfterBlock.mockClear();
    const rehearsal = await buildIdentityExport(busy, {
      ...options,
      freezeMs: null
    });
    expect(rowsAfterBlock).not.toHaveBeenCalled();
    expect(rehearsal.stats.delegations_after_tdh_block).toBe(0);
  });

  it("names the job's event fields when the job asks", async () => {
    const { source } = world();
    const refused = await buildIdentityExport(
      {
        ...source,
        rowsAfterBlock: async () => ({
          consolidations: 2,
          delegations: 2,
          primaryAddressDelegations: 0
        })
      },
      {
        ...options,
        expectTdhBlock: 24_000_000,
        acceptMissingExtraIds: 3,
        acceptStyle: 'event'
      }
    ).then(
      () => null,
      (error: IdentityExportNotReadyError) => error
    );
    expect(refused?.message).toContain(
      'acknowledge with "acceptOverCredit": 2'
    );
    expect(refused?.message).toContain(
      '"acceptMissingExtraIds": 3 does not match: 1 waves-list ids have no identity or profile row (left out); give "acceptMissingExtraIds": 1'
    );
    expect(refused?.message).toContain(
      'with "acceptConsolidationsAfterFreeze": 2'
    );
    expect(refused?.message).not.toContain('--accept');
    expect(acceptName('--accept-ratings-changed-after-freeze', 'event')).toBe(
      'acceptRatingsChangedAfterFreeze'
    );
    expect(acceptName('--accept-over-credit')).toBe('--accept-over-credit');
    expect(
      acknowledgementProblem(0, 2, '--accept-unmatched-cms', 'x', 'event')
    ).toBe(
      '"acceptUnmatchedCms": 2 does not match: 0 x; leave acceptUnmatchedCms out'
    );
  });

  it('holds the delegations to the TDH block, says so, and records what was acknowledged', async () => {
    const { source } = world();
    const log = jest.fn();
    const delegations = jest.fn(source.delegations);
    const doc = await buildIdentityExport(
      { ...source, delegations },
      {
        ...options,
        log,
        notes: ['a note from the caller'],
        acceptNoExtraIds: true,
        acceptBulk: 2
      }
    );
    expect(delegations).toHaveBeenCalledWith(24_000_000);
    expect(doc.rules.delegations).toBe('through_tdh_block');
    expect(doc.notes[0]).toBe('a note from the caller');
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        "delegations: the 1 rows of 6529.io's delegations table with a block at or before the TDH block 24000000, ordered by block, then from, to and collection (lowercase, bytewise), use case and token id (rules.delegations through_tdh_block)"
      ])
    );
    expect(log).toHaveBeenCalledWith('delegations: 1 read');
    expect(doc.acknowledged).toEqual(
      expect.objectContaining({ no_extra_ids: true, bulk: 2 })
    );
    // No TDH block: every row, said so.
    const noTdh = await buildIdentityExport(
      { ...source, delegations, latestTdhBlock: async () => null },
      { ...options, freezeMs: null }
    );
    expect(delegations).toHaveBeenLastCalledWith(null);
    expect(noTdh.rules.delegations).toBe('all_rows');
    const without = await buildIdentityExport(source, {
      ...options,
      includeDelegations: false
    });
    expect(without.delegations).toEqual([]);
    expect(without.rules.delegations).toBe('left_out');
    expect(without.notes).toEqual(
      expect.arrayContaining([
        "no delegations: 6529.io's delegations table was left out (--no-delegations), so the empty list says nothing about delegations (rules.delegations left_out)"
      ])
    );
    expect(without.acknowledged).toEqual(
      expect.objectContaining({ no_extra_ids: false, bulk: null })
    );
  });

  it('takes an empty set of profile site values (a site export with no sites) at the freeze only acknowledged', async () => {
    const { source } = world();
    const atFreeze = {
      ...options,
      expectTdhBlock: 24_000_000,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 1,
      cmsFields: {},
      cmsFieldsFile: {
        count: 0,
        sha256: 'c'.repeat(64),
        manifest: { key: null, sha256: 'd'.repeat(64) }
      }
    };
    const refused = await buildIdentityExport(source, {
      ...atFreeze,
      acceptStyle: 'event'
    }).then(
      () => null,
      (error: IdentityExportNotReadyError) => error
    );
    expect(refused?.causes).toEqual(['unmatched_cms']);
    expect(refused?.exitCode).toBe(7);
    expect(refused?.message).toContain(
      '"acceptNoCmsFields": true; one that should have sites is a fault: report it'
    );
    const wrong = await buildIdentityExport(source, {
      ...atFreeze,
      cmsFields: { [ALICE]: { primary: {} } },
      acceptNoCmsFields: true
    }).then(
      () => null,
      (error: IdentityExportNotReadyError) => error
    );
    expect(wrong?.message).toContain(
      '--accept-no-cms-fields is only for an empty cms-fields.json: this one has 1 profile site values'
    );
    const doc = await buildIdentityExport(source, {
      ...atFreeze,
      acceptNoCmsFields: true
    });
    expect(doc.acknowledged.no_cms_fields).toBe(true);
    expect(doc.cms_fields?.count).toBe(0);
    expect(doc.identities.some((it) => 'cms' in it)).toBe(false);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        'cms: the profile site export has no profile site values (its cms-fields.json is empty), so no identity carries one'
      ])
    );
  });

  it('refuses unmatched profile site values unless acknowledged, and none matching outright', async () => {
    const { source } = world();
    const atFreeze = {
      ...options,
      expectTdhBlock: 24_000_000,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 1
    };
    const run = (cmsFields: Record<string, unknown>, accept = 0) =>
      buildIdentityExport(source, {
        ...atFreeze,
        cmsFields,
        acceptUnmatchedCms: accept
      }).then(
        (doc) => doc,
        (error: IdentityExportNotReadyError) => error
      );
    const some = { [ALICE]: { primary: {} }, [P('dead')]: { primary: {} } };
    const refused = (await run(some)) as IdentityExportNotReadyError;
    expect(refused.causes).toEqual(['unmatched_cms']);
    expect(refused.exitCode).toBe(7);
    expect(refused.message).toContain(
      'acknowledge with --accept-unmatched-cms 1'
    );
    const doc = (await run(some, 1)) as Awaited<
      ReturnType<typeof buildIdentityExport>
    >;
    expect(doc.acknowledged.unmatched_cms).toBe(1);
    expect(doc.stats.cms_unmatched).toBe(1);
    const none = (await run(
      { [P('dead')]: { primary: {} } },
      1
    )) as IdentityExportNotReadyError;
    expect(none.causes).toEqual(['unmatched_cms']);
    expect(none.message).toContain(
      'none of the 1 profile site values is for a profile in the export: the values are of another database or stage. Run the profile site export for this freeze on the same stage'
    );
  });

  it('refuses a waves list none of whose ids matches, even acknowledged', async () => {
    const { source } = world();
    const error = await buildIdentityExport(source, {
      ...options,
      extraProfileIds: [P('dead'), P('beef')],
      expectTdhBlock: 24_000_000,
      acceptOverCredit: 2,
      acceptMissingExtraIds: 2
    }).then(
      () => null,
      (e: IdentityExportNotReadyError) => e
    );
    expect(error?.causes).toEqual(['missing_extra_ids']);
    expect(error?.message).toContain(
      'none of the 2 waves-list ids has an identity or profile row: the wrong list, or a list for another database. Ask the waves lead for the list of this freeze and run again with it'
    );
  });

  it('refuses a freeze that is not 00:00 UTC', () => {
    expect(
      readinessProblems(
        {
          tdh: { block: 1, timestampMs: FREEZE + 1_000 - 12_000 },
          identitySync: null,
          editsAfterFreeze: 0,
          ratingsChangedAfterFreeze: 0
        },
        { freezeMs: FREEZE + 1_000, expectTdhBlock: null }
      )
    ).toEqual([
      {
        cause: 'day',
        message: 'the freeze time 2026-11-24T00:00:01.000Z is not 00:00 UTC'
      }
    ]);
  });

  it('takes an acknowledgement only for the exact count', () => {
    expect(acknowledgementProblem(3, 3, '--accept-x', 'things')).toBeNull();
    expect(acknowledgementProblem(3, 1, '--accept-x', 'things')).toBe(
      '3 things; acknowledge with --accept-x 3'
    );
    expect(acknowledgementProblem(3, 5, '--accept-x', 'things')).toBe(
      '--accept-x 5 does not match: 3 things; give --accept-x 3'
    );
    expect(acknowledgementProblem(0, 2, '--accept-x', 'things')).toBe(
      '--accept-x 2 does not match: 0 things; leave --accept-x out'
    );
  });

  it('writes the input files given, the cms choice and the keys with no row', async () => {
    const { source } = world();
    const doc = await buildIdentityExport(
      {
        ...source,
        multiWalletConsolidationKeys: async () => [
          `${W(6)}-${W(7)}`,
          `${W(12)}-${W(13)}`
        ]
      },
      {
        ...options,
        extraIdsFile: { count: 2, sha256: 'e'.repeat(64) },
        cmsFieldsFile: {
          count: 1,
          sha256: 'c'.repeat(64),
          manifest: {
            key: 'profile-site-export/prod/run/manifest.json',
            sha256: 'd'.repeat(64)
          }
        },
        cmsFields: { [ALICE]: { primary: {} } }
      }
    );
    expect(doc.extra_ids).toEqual({ count: 2, sha256: 'e'.repeat(64) });
    expect(doc.cms_fields).toEqual({
      count: 1,
      sha256: 'c'.repeat(64),
      manifest: {
        key: 'profile-site-export/prod/run/manifest.json',
        sha256: 'd'.repeat(64)
      }
    });
    expect(doc.rules.cms_fields_sha256).toBe('c'.repeat(64));
    expect(doc.stats.multi_wallet_keys_without_identity).toBe(1);
    expect(doc.notes).toEqual(
      expect.arrayContaining([
        '1 consolidation keys of two or more wallets have no identities row: not exported'
      ])
    );
    const none = await buildIdentityExport(source, {
      ...options,
      extraIdsFile: null,
      cmsFieldsFile: null
    });
    expect([
      none.extra_ids,
      none.cms_fields,
      none.rules.cms_fields_sha256
    ]).toEqual([null, null, null]);
    expect(none.notes).toEqual(
      expect.arrayContaining([
        'no --cms-fields: profile site values were not given, so no identity carries a cms value'
      ])
    );
    expect(none.stats.multi_wallet_keys_without_identity).toBe(0);
  });

  it("counts the raters over the chain's cap in the file, by matter", () => {
    const id = (profile: string, tdh: number) =>
      toExportIdentity(
        identity(W(1), { id: profile, handle: profile }, { tdh }),
        [W(1)],
        [],
        ['handle']
      );
    const identities = [id(ALICE, 10.9), id(TAGGER, 3), id(P3, 0)];
    expect(
      overCreditInFile(identities, [
        // Alice: REP |6| + |-4| = 10, within floor(10.9); CIC 10 too.
        rating(ALICE, TAGGER, 'REP', 'A', 6),
        rating(ALICE, P3, 'REP', 'B', -4),
        rating(ALICE, TAGGER, 'CIC', '', 10),
        // TAGGER: REP 4 over floor(3).
        rating(TAGGER, ALICE, 'REP', 'A', 4),
        // P3: nothing given.
        rating(TAGGER, P3, 'CIC', '', 1)
      ])
    ).toBe(1);
    expect(
      overCreditInFile(identities, [rating(ALICE, P3, 'REP', 'A', 11)])
    ).toBe(1);
  });

  it('counts stored cic that the CIC ratings in the file do not add up to', () => {
    const alice = toExportIdentity(
      identity(W(1), { id: ALICE, handle: 'Alice' }, { cic: 20 }),
      [W(1)],
      [],
      ['handle']
    );
    const p3 = toExportIdentity(
      identity(W(5), { id: P3, handle: 'p3' }, { cic: 0 }),
      [W(5)],
      [],
      ['handle']
    );
    const ratings = [
      rating(P3, ALICE, 'CIC', '', 20),
      rating(ALICE, P3, 'REP', 'A', 3)
    ];
    expect(cicMismatches([alice, p3], ratings)).toBe(0);
    expect(cicMismatches([{ ...alice, cic: 21 }, p3], ratings)).toBe(1);
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
