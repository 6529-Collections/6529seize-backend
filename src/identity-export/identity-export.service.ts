import { RESERVED_HANDLES } from '@/api/profiles/profiles.constants';
import {
  HELP_BOT_CREDIT_CATEGORY,
  isHelpBotCreditCategory
} from '@/help-bot/help-bot.config';
import { getLevelFromScore } from '@/profiles/profile-level';
import { ProfileClassification } from '@/entities/IProfile';
import { enums } from '@/enums';
import {
  IdentityExportSource,
  IdentityRow,
  IdentitySyncProgress,
  StatementRow,
  toMillis
} from './identity-export.db';
import {
  BulkCategory,
  bulkKeys,
  compareCodePoints,
  compareRatings,
  findBulkCategories,
  isRealHandle,
  publicExporterReach,
  RatingEdge,
  RatingScope,
  selectRatingScope
} from './identity-export.scope';
import { IdentityExportNotReadyError } from './identity-export.errors';
import {
  IDENTITY_EXPORT_FORMAT,
  IdentityExportDelegation,
  IdentityExportHeader,
  IdentityExportIdentity,
  IdentityExportRating,
  IdentityExportScope,
  IdentityExportStatement
} from './identity-export.types';

export interface IdentityExportOptions {
  /** A rater's REP category with more targets brings no one in (0: off). */
  readonly bulkThreshold: number;
  /** Profiles in scope for waves activity (the waves lead's list at T). */
  readonly extraProfileIds: readonly string[];
  /** False when exported without the waves list (noted in the file). */
  readonly wavesListGiven?: boolean;
  readonly includeDelegations: boolean;
  /** Profile id -> the ProfileDoc `cms` value (the profile site export's). */
  readonly cmsFields?: Readonly<Record<string, unknown>>;
  readonly freezeMs: number | null;
  /**
   * The freeze day's TDH block: the export refuses, before its long reads,
   * unless the TDH block is this one and the identities sync caught up.
   */
  readonly expectTdhBlock?: number | null;
  readonly exporterRevision: string;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface IdentityExportDocument extends IdentityExportHeader {
  readonly identities: IdentityExportIdentity[];
  readonly reserved_handles: string[];
  readonly ratings: IdentityExportRating[];
  readonly delegations: IdentityExportDelegation[];
  readonly notes: string[];
  /** Extra keys, as the public-API exporter writes them. */
  readonly bulk_rep: {
    profile_id: string;
    direction: 'outgoing';
    category: string;
    contributor_count: number;
  }[];
  readonly stats: Record<string, number>;
  /** The rules the file was written by, for the builder to check. */
  readonly rules: typeof IDENTITY_EXPORT_RULES;
  /** The identities sync's state read with everything else (null: unread). */
  readonly identity_sync: IdentitySyncProgress | null;
}

/** The rules every export is written by; the builder refuses a file without. */
export const IDENTITY_EXPORT_RULES = {
  help_bot_credit_category: HELP_BOT_CREDIT_CATEGORY,
  help_bot_credits: 'excluded',
  level: 'rep+tdh',
  tdh: 'boosted',
  xtdh: 'as_stored'
} as const;

/**
 * Each identity whose profile has a profile site gets its `cms` value. A
 * value for a profile the export leaves out is noted: its site would not
 * move to the chain.
 */
export function withCmsFields(
  identities: IdentityExportIdentity[],
  cmsFields: Readonly<Record<string, unknown>> | undefined
): { identities: IdentityExportIdentity[]; notes: string[] } {
  if (!cmsFields) return { identities, notes: [] };
  const used = new Set<string>();
  const out = identities.map((it) => {
    const value = it.profile_id ? cmsFields[it.profile_id] : undefined;
    if (value === undefined || !it.profile_id) return it;
    used.add(it.profile_id);
    return { ...it, cms: value };
  });
  const missing = Object.keys(cmsFields)
    .filter((it) => !used.has(it))
    .sort(compareCodePoints);
  return {
    identities: out,
    notes: [
      `cms: ${used.size} identities carry a profile site value`,
      ...(missing.length
        ? [
            `cms: ${missing.length} profiles with a profile site value are not in the export: ${missing.join(', ')}`
          ]
        : [])
    ]
  };
}

export interface HelpBotCredits {
  /** Target profile id -> the sum of its help-bot credits. */
  readonly byTarget: Map<string, number>;
  readonly ratings: number;
  /** Ratings in the category whose rater isn't the help bot's profile. */
  readonly fromOthers?: number;
}

/**
 * The whole rule, written in every export so the public-API exporter can
 * apply the same one.
 */
export const HELP_BOT_CREDIT_RULE_NOTE = `help-bot credits: every REP rating in the category "${HELP_BOT_CREDIT_CATEGORY}" (any case, surrounding spaces ignored), from any rater, is dropped before the bulk rule and left out of ratings, bulk_rep, rep, level_raw and level; the public-API exporter must apply the same rule`;

export const TDH_NOTE =
  "tdh is 6529.io's boosted TDH (identities.tdh, the consolidated boosted_tdh); the builder and the validator must count the same TDH";

/**
 * Why the export is not of a finished TDH day, or null: the identities
 * sync must have caught up with the last consolidated-TDH write, and that
 * write must be of the TDH block the export reports.
 */
export function identitySyncProblem(
  tdhBlock: number | null,
  progress: IdentitySyncProgress | null
): string | null {
  if (!progress) {
    return "the identities sync's state (identity_tdh_sync_state) could not be read";
  }
  if (progress.syncedGeneration < progress.pendingGeneration) {
    return `the identities sync is behind: generation ${progress.syncedGeneration} synced, ${progress.pendingGeneration} pending`;
  }
  if (progress.pendingBlock !== tdhBlock) {
    return `the last TDH write is of block ${progress.pendingBlock}, not the TDH block ${tdhBlock}`;
  }
  return null;
}

/**
 * Whether the export is the freeze day's, for --expect-tdh-block: the TDH
 * block is the one expected and the identities are synced to it.
 */
export function freezeDayProblem(
  document: Pick<IdentityExportDocument, 'tdh_block' | 'identity_sync'>,
  expectTdhBlock: number
): string | null {
  if (document.tdh_block !== expectTdhBlock) {
    return `6529.io's latest TDH block is ${document.tdh_block}, not ${expectTdhBlock}`;
  }
  return identitySyncProblem(document.tdh_block, document.identity_sync);
}

/**
 * The REP and CIC ratings (help-bot credits already left out) last changed
 * after the freeze time; none without one.
 */
export function modifiedAfter(
  edges: readonly { last_modified_ms: number | null }[],
  freezeMs: number | null
): number {
  if (freezeMs === null) return 0;
  return edges.filter(
    (it) => it.last_modified_ms !== null && it.last_modified_ms > freezeMs
  ).length;
}

/**
 * For each exported identity, whether its stored rep is the sum of the REP
 * ratings read for it (credits included): the number that differ.
 */
export function repMismatches(
  identities: readonly IdentityExportIdentity[],
  edges: readonly {
    matter: string;
    target_profile_id: string;
    rating: number;
  }[]
): number {
  const sums = new Map<string, number>();
  for (const edge of edges) {
    if (edge.matter !== 'REP') continue;
    sums.set(
      edge.target_profile_id,
      (sums.get(edge.target_profile_id) ?? 0) + edge.rating
    );
  }
  return identities.filter(
    (it) => it.profile_id !== null && it.rep !== (sums.get(it.profile_id) ?? 0)
  ).length;
}

/**
 * The help bot's credits (REP in its reserved category, matched without
 * regard to case or surrounding spaces) are a 6529.io site feature that the
 * chain doesn't import: they stay in 6529.io's ratings table and keep
 * working through the freeze. Returns the other ratings and the credits per
 * target.
 */
export function leaveOutHelpBotCredits<
  T extends {
    rater_profile_id: string;
    matter: string;
    category: string;
    target_profile_id: string;
    rating: number;
  }
>(
  edges: T[],
  helpBotProfileId: string | null = null
): { edges: T[]; credits: HelpBotCredits } {
  const byTarget = new Map<string, number>();
  let ratings = 0;
  let fromOthers = 0;
  const kept = edges.filter((edge) => {
    if (edge.matter !== 'REP' || !isHelpBotCreditCategory(edge.category)) {
      return true;
    }
    byTarget.set(
      edge.target_profile_id,
      (byTarget.get(edge.target_profile_id) ?? 0) + edge.rating
    );
    ratings++;
    if (edge.rater_profile_id.toLowerCase() !== helpBotProfileId) fromOthers++;
    return false;
  });
  return { edges: kept, credits: { byTarget, ratings, fromOthers } };
}

/**
 * Each identity's rep and level as the chain will have them: without the
 * help-bot credits it received. The rep, level_raw and ratings come from one
 * read-only snapshot, so a credit given while the export runs is either in
 * all of them or in none.
 */
export function withoutCredits(
  identities: IdentityExportIdentity[],
  credits: HelpBotCredits
): IdentityExportIdentity[] {
  if (!credits.ratings) return identities;
  return identities.map((it) => {
    const credit = it.profile_id
      ? (credits.byTarget.get(it.profile_id) ?? 0)
      : 0;
    if (!credit) return it;
    const levelRaw = it.level_raw - credit;
    return {
      ...it,
      rep: it.rep - credit,
      level_raw: levelRaw,
      level: getLevelFromScore(levelRaw)
    };
  });
}

export function reservedHandles(): string[] {
  return Array.from(new Set(RESERVED_HANDLES.map((it) => it.toLowerCase())))
    .filter((it) => it.length > 0)
    .sort(compareCodePoints);
}

function numberOr(value: number | string | null, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStatement(row: StatementRow): IdentityExportStatement {
  return {
    id: row.id,
    statement_group: row.statement_group,
    statement_type: row.statement_type,
    statement_value: row.statement_value,
    statement_comment: row.statement_comment ?? null,
    created_at_ms: toMillis(row.crated_at) ?? 0
  };
}

export function toExportIdentity(
  row: IdentityRow,
  wallets: readonly string[],
  statements: readonly IdentityExportStatement[],
  scope: IdentityExportScope[]
): IdentityExportIdentity {
  const hasProfile = !!row.p_external_id;
  const primary = row.primary_address.toLowerCase();
  const walletList = Array.from(
    new Set((wallets.length ? wallets : [primary]).map((w) => w.toLowerCase()))
  ).sort(compareCodePoints);
  const rep = Math.trunc(numberOr(row.rep, 0));
  const tdh = numberOr(row.tdh, 0);
  // The chain's level: REP + TDH. 6529.io's level_raw also adds xTDH, which
  // is not on the chain (xtdh is still written as stored).
  const levelRaw = rep + tdh;
  return {
    profile_id: hasProfile ? row.p_external_id!.toLowerCase() : null,
    handle: hasProfile ? row.p_handle : null,
    normalised_handle: hasProfile ? row.p_normalised_handle : null,
    primary_address: primary,
    wallets: walletList,
    consolidation_key: row.consolidation_key,
    classification: shownClassification(row.classification),
    sub_classification: row.sub_classification ?? null,
    pfp: row.pfp ?? null,
    banner1: row.banner1 ?? null,
    banner2: row.banner2 ?? null,
    website: hasProfile ? (row.p_website ?? null) : null,
    statements: [...statements].sort((a, b) => compareCodePoints(a.id, b.id)),
    tdh,
    xtdh: numberOr(row.xtdh, 0),
    rep,
    cic: Math.trunc(numberOr(row.cic, 0)),
    level: getLevelFromScore(levelRaw),
    level_raw: levelRaw,
    scope
  };
}

/**
 * The classification as 6529.io shows it (the public API and so the
 * public-API export): unset or unknown reads as PSEUDONYM.
 */
export function shownClassification(value: string | null): string {
  return (
    (value ? enums.resolve(ProfileClassification, value) : null) ??
    ProfileClassification.PSEUDONYM
  );
}

function compareIdentities(
  a: IdentityExportIdentity,
  b: IdentityExportIdentity
): number {
  if ((a.profile_id === null) !== (b.profile_id === null)) {
    return a.profile_id === null ? 1 : -1;
  }
  return (
    compareCodePoints(a.profile_id ?? '', b.profile_id ?? '') ||
    compareCodePoints(a.primary_address, b.primary_address)
  );
}

/** The identity rows read so far, by consolidation key and by profile. */
class IdentityIndex {
  readonly rowsByKey = new Map<string, IdentityRow>();
  readonly keyByProfile = new Map<string, string>();
  private readonly tried = new Set<string>();

  constructor(private readonly source: IdentityExportSource) {}

  private remember(rows: IdentityRow[]) {
    for (const row of rows) {
      this.rowsByKey.set(row.consolidation_key, row);
      if (row.p_external_id) {
        this.keyByProfile.set(
          row.p_external_id.toLowerCase(),
          row.consolidation_key
        );
      }
    }
  }

  /** Reads the profiles not read yet (each profile id once). */
  async readProfiles(profileIds: string[]): Promise<void> {
    const toRead = profileIds.filter(
      (it) => !this.keyByProfile.has(it) && !this.tried.has(it)
    );
    if (toRead.length) {
      this.remember(await this.source.identitiesByProfileIds(toRead));
      toRead.forEach((it) => this.tried.add(it));
    }
  }

  async readConsolidations(keys: string[]): Promise<void> {
    this.remember(await this.source.identitiesByConsolidationKeys(keys));
  }

  has(profileId: string): boolean {
    return this.keyByProfile.has(profileId);
  }

  profileOfKey(key: string): string | null {
    return this.rowsByKey.get(key)?.p_external_id?.toLowerCase() ?? null;
  }
}

interface Core {
  readonly profiles: Set<string>;
  readonly multiWalletKeys: string[];
  readonly extraIds: string[];
  readonly extraMissing: string[];
}

/** The core: real handles, multi-wallet consolidations, the waves list. */
async function readCore(
  source: IdentityExportSource,
  index: IdentityIndex,
  extraProfileIds: readonly string[]
): Promise<Core> {
  const realHandles = (await source.realHandleProfileIds()).map((it) =>
    it.toLowerCase()
  );
  await index.readProfiles(realHandles);
  const multiWalletKeys = await source.multiWalletConsolidationKeys();
  await index.readConsolidations(multiWalletKeys);
  const extraIds = Array.from(
    new Set(extraProfileIds.map((it) => it.trim().toLowerCase()))
  ).filter((it) => it.length > 0);
  await index.readProfiles(extraIds);
  const profiles = new Set<string>([...realHandles, ...extraIds]);
  for (const key of multiWalletKeys) {
    const profile = index.profileOfKey(key);
    if (profile) profiles.add(profile);
  }
  return {
    profiles,
    multiWalletKeys,
    extraIds,
    extraMissing: extraIds.filter((it) => !index.has(it))
  };
}

/**
 * The rating scope, reading the profiles it brings in; a profile with no
 * identity or profile row is excluded and the scope worked out again.
 */
async function resolveScope(
  index: IdentityIndex,
  core: Core,
  edges: RatingEdge[],
  bulk: Set<string>
): Promise<{ scope: RatingScope; excluded: Set<string> }> {
  const excluded = new Set<string>(core.extraMissing);
  for (;;) {
    const scope = selectRatingScope({
      core: core.profiles,
      edges,
      bulk,
      excluded
    });
    const profiles = Array.from(scope.profiles);
    await index.readProfiles(profiles);
    const notFound = profiles.filter((it) => !index.has(it));
    if (!notFound.length) {
      return { scope, excluded };
    }
    notFound.forEach((it) => excluded.add(it));
  }
}

function scopeLabels(
  row: IdentityRow,
  wallets: readonly string[],
  scope: RatingScope,
  extra: ReadonlySet<string>
): IdentityExportScope[] {
  const profile = row.p_external_id?.toLowerCase() ?? null;
  const labels: IdentityExportScope[] = [];
  if (profile && isRealHandle(row.p_handle)) labels.push('handle');
  if (wallets.length >= 2) labels.push('wallets');
  if (profile && scope.rated.has(profile)) labels.push('rating');
  if (profile && extra.has(profile)) labels.push('waves');
  return labels;
}

async function readStatements(
  source: IdentityExportSource,
  profileIds: string[]
): Promise<Map<string, IdentityExportStatement[]>> {
  const byProfile = new Map<string, IdentityExportStatement[]>();
  for (const row of await source.statementsByProfileIds(profileIds)) {
    const profile = row.profile_id.toLowerCase();
    const list = byProfile.get(profile) ?? [];
    list.push(toStatement(row));
    byProfile.set(profile, list);
  }
  return byProfile;
}

function identityNotes(
  keys: string[],
  wallets: Map<string, string[]>
): string[] {
  const notes: string[] = [];
  const walletsMissing = keys.filter(
    (key) => !(wallets.get(key) ?? []).length
  ).length;
  if (walletsMissing) {
    notes.push(
      `${walletsMissing} identities have no address_consolidation_keys row: their primary address is their one wallet`
    );
  }
  return notes;
}

/** The identities: profiles in scope, and multi-wallet ones without one. */
async function buildIdentities(
  source: IdentityExportSource,
  index: IdentityIndex,
  core: Core,
  scope: RatingScope
): Promise<{ identities: IdentityExportIdentity[]; notes: string[] }> {
  const exportKeys = new Set<string>();
  scope.profiles.forEach((it) => exportKeys.add(index.keyByProfile.get(it)!));
  for (const key of core.multiWalletKeys) {
    if (index.rowsByKey.has(key) && !index.profileOfKey(key)) {
      exportKeys.add(key);
    }
  }
  const keys = Array.from(exportKeys).sort(compareCodePoints);
  const wallets = await source.walletsByConsolidationKeys(keys);
  // Only profiles with a real handle have a profile document's statements,
  // as the public-API export reads them.
  const statements = await readStatements(
    source,
    keys
      .filter((key) => isRealHandle(index.rowsByKey.get(key)?.p_handle ?? null))
      .map((key) => index.profileOfKey(key))
      .filter((it): it is string => !!it)
  );
  const extra = new Set(core.extraIds);
  const identities = keys
    .map((key) => {
      const row = index.rowsByKey.get(key)!;
      const list = wallets.get(key) ?? [];
      const profile = index.profileOfKey(key);
      return toExportIdentity(
        row,
        list,
        profile ? (statements.get(profile) ?? []) : [],
        scopeLabels(row, list, scope, extra)
      );
    })
    .filter((it) => it.scope.length > 0)
    .sort(compareIdentities);
  return { identities, notes: identityNotes(keys, wallets) };
}

function scopeNotes(
  core: Core,
  excluded: Set<string>,
  bulkCategories: BulkCategory[],
  bulkThreshold: number,
  scope: RatingScope
): string[] {
  const notes: string[] = [];
  if (core.extraMissing.length) {
    notes.push(
      `${core.extraMissing.length} waves-list profile ids have no identity or profile row: left out`
    );
  }
  const unresolved = Array.from(excluded).filter(
    (it) => !core.extraMissing.includes(it)
  );
  if (unresolved.length) {
    notes.push(
      `${unresolved.length} profiles named by ratings have no identity or profile row: left out with their ratings`
    );
  }
  if (bulkCategories.length) {
    notes.push(
      `${bulkCategories.length} given REP categories with more than ${bulkThreshold} targets bring no one in: ${scope.bulkLeftOut} of their ratings name a profile not otherwise in scope and are left out (see bulk_rep)`
    );
  }
  return notes;
}

/**
 * Reads the identities in scope, their ratings, the reserved handles and
 * (optionally) 6529.io's delegations, and returns the export document.
 * Only reads: the source is read-only.
 */
export async function buildIdentityExport(
  source: IdentityExportSource,
  options: IdentityExportOptions
): Promise<IdentityExportDocument> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const startedAt = now();

  // The day first, in the same snapshot: a wrong one is refused before the
  // long reads.
  const tdhBlock = await source.latestTdhBlock();
  const identitySync = await source.identitySyncProgress();
  const expected = options.expectTdhBlock ?? null;
  if (expected !== null) {
    const problem = freezeDayProblem(
      { tdh_block: tdhBlock, identity_sync: identitySync },
      expected
    );
    if (problem) throw new IdentityExportNotReadyError(problem);
  }

  const index = new IdentityIndex(source);
  const core = await readCore(source, index, options.extraProfileIds);
  log(
    `core: ${core.profiles.size} profiles (${core.multiWalletKeys.length} multi-wallet consolidations, ${core.extraIds.length} waves)`
  );

  const read = (await source.ratingEdges()).map((edge) => ({
    ...edge,
    rater_profile_id: edge.rater_profile_id.toLowerCase(),
    target_profile_id: edge.target_profile_id.toLowerCase()
  }));
  const helpBotProfileId = await source.helpBotProfileId();
  const { edges, credits } = leaveOutHelpBotCredits(read, helpBotProfileId);
  const bulkCategories = findBulkCategories(edges, options.bulkThreshold);
  const bulk = bulkKeys(bulkCategories);
  log(
    `ratings: ${edges.length} REP and CIC, ${bulkCategories.length} bulk categories`
  );
  const { scope, excluded } = await resolveScope(index, core, edges, bulk);
  const built = await buildIdentities(source, index, core, scope);
  const repMismatch = repMismatches(built.identities, read);
  const cms = withCmsFields(
    withoutCredits(built.identities, credits),
    options.cmsFields
  );
  const identities = cms.identities;
  const notes = [
    ...(options.wavesListGiven === false
      ? [
          'no --extra-ids: profiles in scope only for waves activity (drops, entries, waves, votes, wave ratings, group lists) are not included'
        ]
      : []),
    ...scopeNotes(core, excluded, bulkCategories, options.bulkThreshold, scope),
    `level and level_raw are the chain's: REP + TDH, without xTDH (xtdh is written as stored) and without help-bot credits; the public-API exporter must write them the same way`,
    TDH_NOTE,
    HELP_BOT_CREDIT_RULE_NOTE,
    ...(credits.ratings
      ? [
          `help-bot credits left out: ${credits.ratings} REP ratings in the help bot's category to ${credits.byTarget.size} profiles; each identity's rep and level_raw exclude them (a 6529.io site feature the chain doesn't import)`
        ]
      : []),
    ...(credits.fromOthers
      ? [
          `help-bot credits: ${credits.fromOthers} ratings in the help bot's category come from a rater that is not the help bot's profile${helpBotProfileId ? '' : ' (no help bot profile was found)'}; left out like the rest`
        ]
      : []),
    ...(repMismatch
      ? [
          `${repMismatch} exported profiles have a stored rep that is not the sum of their REP ratings read (credits included): the builder should trust the ratings, from which the chain counts REP`
        ]
      : []),
    ...built.notes,
    ...cms.notes
  ];
  const exportedProfiles = new Set(
    identities.map((it) => it.profile_id).filter((it): it is string => !!it)
  );
  const ratings = scope.ratings
    .filter(
      (it) =>
        exportedProfiles.has(it.rater_profile_id) &&
        exportedProfiles.has(it.target_profile_id)
    )
    .sort(compareRatings);

  const repFromFile = repMismatches(identities, ratings);
  if (repFromFile) {
    notes.push(
      `${repFromFile} exported profiles have a rep that is not the sum of the REP ratings to them in this file: the chain counts REP from the file's ratings, so theirs will differ (ratings from raters left out of the export, or a stored rep that drifted)`
    );
  }
  const afterFreeze = modifiedAfter(edges, options.freezeMs);
  if (afterFreeze) {
    notes.push(
      `${afterFreeze} REP and CIC ratings (help-bot credits left out) were changed after the freeze time: the freeze should have stopped them`
    );
  }

  // Diagnostic for the comparison with the public-API export.
  const reach = publicExporterReach({ core: core.profiles, edges, bulk });
  const outsideReach = Array.from(exportedProfiles).filter(
    (it) => !reach.has(it)
  ).length;
  if (outsideReach) {
    notes.push(
      `${outsideReach} exported profiles lie outside the public-API exporter's two rounds from the core (expected differences between the two exports)`
    );
  }

  const syncProblem = identitySyncProblem(tdhBlock, identitySync);
  if (syncProblem) {
    notes.push(
      `not a finished TDH day: ${syncProblem} (--expect-tdh-block refuses such an export)`
    );
  }
  const delegations = options.includeDelegations
    ? await source.delegations()
    : [];
  const byScope = (label: IdentityExportScope) =>
    identities.filter((it) => it.scope.includes(label)).length;
  return {
    format: IDENTITY_EXPORT_FORMAT,
    source: 'database',
    exporter_revision: options.exporterRevision,
    started_at_ms: startedAt,
    finished_at_ms: now(),
    freeze_ms: options.freezeMs,
    tdh_block: tdhBlock,
    identities,
    reserved_handles: reservedHandles(),
    ratings,
    delegations,
    notes,
    rules: IDENTITY_EXPORT_RULES,
    identity_sync: identitySync,
    bulk_rep: bulkCategories.map((it) => ({
      profile_id: it.rater_profile_id,
      direction: 'outgoing' as const,
      category: it.category,
      contributor_count: it.targets
    })),
    stats: {
      identities: identities.length,
      with_profile: exportedProfiles.size,
      scope_handle: byScope('handle'),
      scope_wallets: byScope('wallets'),
      scope_rating: byScope('rating'),
      scope_waves: byScope('waves'),
      ratings: ratings.length,
      ratings_read: read.length,
      help_bot_credits_left_out: credits.ratings,
      help_bot_credit_profiles: credits.byTarget.size,
      help_bot_credits_from_others: credits.fromOthers ?? 0,
      rep_mismatch: repMismatch,
      rep_differs_from_file_ratings: repFromFile,
      ratings_modified_after_freeze: afterFreeze,
      identity_sync_pending_generation: identitySync?.pendingGeneration ?? -1,
      identity_sync_synced_generation: identitySync?.syncedGeneration ?? -1,
      identity_sync_pending_block: identitySync?.pendingBlock ?? -1,
      bulk_categories: bulkCategories.length,
      bulk_ratings_left_out: scope.bulkLeftOut,
      profiles_left_out: excluded.size,
      outside_public_reach: outsideReach,
      delegations: delegations.length
    }
  };
}
