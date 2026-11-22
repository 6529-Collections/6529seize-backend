import { RESERVED_HANDLES } from '@/api/profiles/profiles.constants';
import {
  HELP_BOT_CREDIT_CATEGORY,
  isHelpBotCreditCategory
} from '@/help-bot/help-bot.config';
import { getLevelFromScore } from '@/profiles/profile-level';
import { ProfileClassification } from '@/entities/IProfile';
import { enums } from '@/enums';
import {
  ChangedRating,
  IdentityExportSource,
  IdentityRow,
  IdentitySyncProgress,
  OverCreditRaters,
  StatementRow,
  TdhBlock,
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
import {
  IdentityExportNotReadyError,
  NotReadyProblem
} from './identity-export.errors';
import {
  IDENTITY_EXPORT_FORMAT,
  IdentityExportDelegation,
  IdentityExportHeader,
  IdentityExportIdentity,
  IdentityExportRating,
  InputFile,
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
  /** Raters over their credit acknowledged at the freeze (default 0). */
  readonly acceptOverCredit?: number;
  /** REP and CIC edits logged after the freeze acknowledged (default 0). */
  readonly acceptEditsAfterFreeze?: number;
  /** REP and CIC ratings changed after the freeze acknowledged (default 0). */
  readonly acceptRatingsChangedAfterFreeze?: number;
  /** Waves-list ids with no identity acknowledged (default 0). */
  readonly acceptMissingExtraIds?: number;
  /** The waves list's file (count and sha256); null without one. */
  readonly extraIdsFile?: InputFile | null;
  /** The profile site values' file (count and sha256); null without one. */
  readonly cmsFieldsFile?: InputFile | null;
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
  readonly rules: ReturnType<typeof exportRules>;
  /** The identities sync's state read with everything else (null: unread). */
  readonly identity_sync: IdentitySyncProgress | null;
  /** REP and CIC ratings changed after the freeze (credits aside). */
  readonly ratings_changed_after_freeze: ChangedRating[];
}

/** The rules every export is written by; the builder refuses a file without. */
export function exportRules(
  bulkThreshold: number,
  cmsFieldsSha256: string | null = null
) {
  return {
    help_bot_credit_category: HELP_BOT_CREDIT_CATEGORY,
    help_bot_credit_match: 'js_trim_then_to_lower_case',
    help_bot_credits: 'excluded',
    rep: 'sum_of_file_ratings',
    cic: 'as_stored',
    level: 'rep+tdh',
    level_table: '6529.io levels, capped at 100',
    tdh: 'boosted',
    xtdh: 'as_stored',
    bulk_threshold: bulkThreshold,
    cms_fields_sha256: cmsFieldsSha256
  } as const;
}

/** A TDH block is the freeze day's when taken within this before the freeze. */
const TDH_BLOCK_WINDOW_MS = 60 * 60 * 1000;

/**
 * Why the TDH block can't be the freeze day's, or null: 6529.io takes the
 * last Ethereum block at or before 00:00 UTC (tdhLoop), so the freeze day's
 * block is at most an hour before the freeze and never after it.
 */
export function tdhBlockTimingProblem(
  tdh: TdhBlock | null,
  freezeMs: number
): string | null {
  const at = tdh?.timestampMs ?? null;
  if (at === null) return 'the TDH block has no timestamp';
  if (at > freezeMs || at <= freezeMs - TDH_BLOCK_WINDOW_MS) {
    return `the TDH block ${tdh!.block} is of ${new Date(at).toISOString()}, not of the hour before the freeze ${new Date(freezeMs).toISOString()}`;
  }
  return null;
}

/** What the export checks first, in the same snapshot, before the long reads. */
export interface ExportReadiness {
  readonly tdh: TdhBlock | null;
  readonly identitySync: IdentitySyncProgress | null;
  readonly editsAfterFreeze: number;
  readonly ratingsChangedAfterFreeze: number;
}

/**
 * The acknowledgement of a count at the freeze must be exactly the count:
 * a problem when it is not.
 */
export function acknowledgementProblem(
  count: number,
  accepted: number,
  flag: string,
  what: string
): string | null {
  if (count === accepted) return null;
  return accepted < count
    ? `${count} ${what}; acknowledge with ${flag} ${count}`
    : `${flag} ${accepted} does not match: ${count} ${what}${count ? `; give ${flag} ${count}` : `; leave ${flag} out`}`;
}

/** Every reason the export is not the freeze day's (empty when it is). */
export function readinessProblems(
  readiness: ExportReadiness,
  options: Pick<
    IdentityExportOptions,
    | 'freezeMs'
    | 'expectTdhBlock'
    | 'acceptEditsAfterFreeze'
    | 'acceptRatingsChangedAfterFreeze'
  >
): NotReadyProblem[] {
  // The counts below are gated only at the freeze (--expect-tdh-block).
  const problems: NotReadyProblem[] = [];
  if (options.freezeMs !== null) {
    const timing = tdhBlockTimingProblem(readiness.tdh, options.freezeMs);
    if (timing) problems.push({ cause: 'day', message: timing });
  }
  const expected = options.expectTdhBlock ?? null;
  if (expected === null) return problems;
  const day = freezeDayProblem(
    {
      tdh_block: readiness.tdh?.block ?? null,
      identity_sync: readiness.identitySync
    },
    expected
  );
  if (day) problems.push({ cause: 'day', message: day });
  const edits = acknowledgementProblem(
    readiness.editsAfterFreeze,
    options.acceptEditsAfterFreeze ?? 0,
    '--accept-edits-after-freeze',
    'REP and CIC rating edits were logged after the freeze (over-rate cuts and help-bot credits aside)'
  );
  if (edits) problems.push({ cause: 'after_freeze', message: edits });
  const changed = acknowledgementProblem(
    readiness.ratingsChangedAfterFreeze,
    options.acceptRatingsChangedAfterFreeze ?? 0,
    '--accept-ratings-changed-after-freeze',
    'REP and CIC ratings were changed after the freeze (help-bot credits aside; listed in ratings_changed_after_freeze)'
  );
  if (changed) problems.push({ cause: 'after_freeze', message: changed });
  return problems;
}

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
export const HELP_BOT_CREDIT_RULE_NOTE = `help-bot credits: every REP rating whose category, after JavaScript's trim() then toLowerCase(), equals "${HELP_BOT_CREDIT_CATEGORY.toLowerCase()}", from any rater, is dropped before the bulk rule and left out of ratings, bulk_rep, rep, level_raw and level; the public-API exporter must apply the same rule`;

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
  // A partial write (delegations) also records the day's block; only the
  // daily full write rewrites every identity's TDH.
  if ((progress.fullWriteBlock ?? null) !== tdhBlock) {
    return `the last full TDH write is of block ${progress.fullWriteBlock ?? 'none'}, not ${tdhBlock}: the day's full TDH run hasn't been written yet`;
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
 * The raters who give more in this file, in one matter (REP or CIC, summed
 * as absolute values), than floor(TDH) of their exported identity: the
 * chain's cap.
 */
export function overCreditInFile(
  identities: readonly IdentityExportIdentity[],
  ratings: readonly IdentityExportRating[]
): number {
  const tdh = new Map<string, number>();
  for (const it of identities) {
    if (it.profile_id) tdh.set(it.profile_id, it.tdh);
  }
  const given = new Map<string, number>();
  for (const it of ratings) {
    const key = `${it.rater_profile_id} ${it.matter}`;
    given.set(key, (given.get(key) ?? 0) + Math.abs(it.rating));
  }
  const over = new Set<string>();
  for (const [key, sum] of Array.from(given.entries())) {
    const rater = key.split(' ')[0];
    if (sum > Math.floor(tdh.get(rater) ?? 0)) over.add(rater);
  }
  return over.size;
}

/** Profiles whose stored cic is not the sum of the CIC ratings to them here. */
export function cicMismatches(
  identities: readonly IdentityExportIdentity[],
  ratings: readonly IdentityExportRating[]
): number {
  const sums = new Map<string, number>();
  for (const it of ratings) {
    if (it.matter !== 'CIC') continue;
    sums.set(
      it.target_profile_id,
      (sums.get(it.target_profile_id) ?? 0) + it.rating
    );
  }
  return identities.filter(
    (it) => it.profile_id !== null && it.cic !== (sums.get(it.profile_id) ?? 0)
  ).length;
}

/**
 * Each identity's rep, level_raw and level from the file: rep the sum of the
 * file's REP ratings to it, level_raw that plus TDH, level 6529.io's table.
 */
export function withFileRep(
  identities: readonly IdentityExportIdentity[],
  ratings: readonly IdentityExportRating[]
): IdentityExportIdentity[] {
  const sums = new Map<string, number>();
  for (const it of ratings) {
    if (it.matter !== 'REP') continue;
    sums.set(
      it.target_profile_id,
      (sums.get(it.target_profile_id) ?? 0) + it.rating
    );
  }
  return identities.map((it) => {
    const rep = it.profile_id ? (sums.get(it.profile_id) ?? 0) : 0;
    const levelRaw = rep + it.tdh;
    return {
      ...it,
      rep,
      level_raw: levelRaw,
      level: getLevelFromScore(levelRaw)
    };
  });
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
 * The help bot's credits (REP in its reserved category, matched after
 * trim() then toLowerCase()) are a 6529.io site feature that the
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
  // REP + TDH. 6529.io's level_raw also adds xTDH, which is not on the
  // chain (xtdh is still written as stored).
  const levelRaw = rep + tdh;
  const ioLevelRaw = numberOr(row.level_raw, 0);
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
    io_rep: numberOr(row.rep, 0),
    io_level_raw: ioLevelRaw,
    io_level: getLevelFromScore(ioLevelRaw),
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
  const tdh = await source.latestTdhBlock();
  const tdhBlock = tdh?.block ?? null;
  const identitySync = await source.identitySyncProgress();
  const overCredit = await source.overCreditRaters();
  const editsAfterFreeze =
    options.freezeMs === null
      ? 0
      : await source.ratingEditsSince(options.freezeMs);
  const changedAfterFreeze =
    options.freezeMs === null
      ? []
      : await source.ratingsChangedSince(options.freezeMs);
  const ratingsChangedAfterFreeze = changedAfterFreeze.length;
  // Every reason is gathered and reported together once all is read.
  const problems = readinessProblems(
    {
      tdh,
      identitySync,
      editsAfterFreeze,
      ratingsChangedAfterFreeze
    },
    options
  );

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
  // Stored rep without the credits: compared below with the file's ratings.
  const storedMinusCredits = withoutCredits(built.identities, credits);
  const notes = [
    ...(options.wavesListGiven === false
      ? [
          'no --extra-ids: profiles in scope only for waves activity (drops, entries, waves, votes, wave ratings, group lists) are not included'
        ]
      : []),
    ...scopeNotes(core, excluded, bulkCategories, options.bulkThreshold, scope),
    `rep is the sum of the REP ratings to the profile in this file (help-bot credits are not in it); level_raw is rep + TDH, without xTDH (xtdh is written as stored); level is 6529.io's level table on level_raw, capped at 100 (rules.level_table): the builder must compute the chain's level from level_raw. cic is as stored. io_rep, io_level_raw and io_level are 6529.io's own values as stored, xTDH and help-bot credits included, for comparisons with 6529.io. The public-API exporter must write these fields the same way`,
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
    ...built.notes
  ];
  const exportedProfiles = new Set(
    storedMinusCredits
      .map((it) => it.profile_id)
      .filter((it): it is string => !!it)
  );
  const ratings = scope.ratings
    .filter(
      (it) =>
        exportedProfiles.has(it.rater_profile_id) &&
        exportedProfiles.has(it.target_profile_id)
    )
    .sort(compareRatings);

  // rep, level_raw and level from the file's ratings.
  const cms = withCmsFields(
    withFileRep(storedMinusCredits, ratings),
    options.cmsFields
  );
  const identities = cms.identities;
  notes.push(
    ...(options.cmsFieldsFile === null
      ? [
          'no --cms-fields: profile site values were not given, so no identity carries a cms value'
        ]
      : []),
    ...cms.notes
  );
  const repFromFile = repMismatches(storedMinusCredits, ratings);
  if (repFromFile) {
    notes.push(
      `${repFromFile} exported profiles have a stored rep (help-bot credits aside) that is not the sum of the REP ratings to them in this file, from raters left out of the export or a stored rep that drifted: their rep and level here are the file's, as the chain will count them, not 6529.io's`
    );
  }
  // Over credit in the file itself, against the chain's cap: refused at the
  // freeze unless acknowledged; nothing has been written yet.
  const overInFile = overCreditInFile(identities, ratings);
  const atFreeze = (options.expectTdhBlock ?? null) !== null;
  if (atFreeze) {
    const over = acknowledgementProblem(
      overInFile,
      options.acceptOverCredit ?? 0,
      '--accept-over-credit',
      "raters give more REP or CIC in this file than floor(TDH) of their identity, the chain's cap (exported as they are once acknowledged)"
    );
    if (over) problems.push({ cause: 'over_credit', message: over });
    const missing = acknowledgementProblem(
      core.extraMissing.length,
      options.acceptMissingExtraIds ?? 0,
      '--accept-missing-extra-ids',
      'waves-list ids have no identity or profile row (left out)'
    );
    if (missing)
      problems.push({ cause: 'missing_extra_ids', message: missing });
  }
  if (problems.length) {
    throw new IdentityExportNotReadyError(problems);
  }
  if (overInFile || overCredit.withXtdh || overCredit.tdhOnly) {
    notes.push(
      `${overInFile} raters give more REP or CIC in this file than floor(TDH) of their identity (the chain's cap); in 6529.io's ratings, ${overCredit.withXtdh} are over TDH + xTDH (its over-rates loop) and ${overCredit.tdhOnly} over TDH alone; their ratings are exported as they are`
    );
  }
  const keysWithoutIdentity = core.multiWalletKeys.filter(
    (key) => !index.rowsByKey.has(key)
  ).length;
  if (keysWithoutIdentity) {
    notes.push(
      `${keysWithoutIdentity} consolidation keys of two or more wallets have no identities row: not exported`
    );
  }
  const cicFromFile = cicMismatches(identities, ratings);
  if (cicFromFile) {
    notes.push(
      `${cicFromFile} exported profiles have a stored cic that is not the sum of the CIC ratings to them in this file (rules.cic as_stored)`
    );
  }
  if (editsAfterFreeze) {
    notes.push(
      `${editsAfterFreeze} REP and CIC rating edits were logged after the freeze (over-rate cuts and help-bot credits aside)`
    );
  }
  if (ratingsChangedAfterFreeze) {
    notes.push(
      `${ratingsChangedAfterFreeze} REP and CIC ratings were changed after the freeze (help-bot credits aside, zeros included)`
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
    tdh_block_timestamp_ms: tdh?.timestampMs ?? null,
    extra_ids: options.extraIdsFile ?? null,
    cms_fields: options.cmsFieldsFile ?? null,
    acknowledged: {
      over_credit: options.acceptOverCredit ?? 0,
      edits_after_freeze: options.acceptEditsAfterFreeze ?? 0,
      ratings_changed_after_freeze:
        options.acceptRatingsChangedAfterFreeze ?? 0,
      missing_extra_ids: options.acceptMissingExtraIds ?? 0
    },
    identities,
    reserved_handles: reservedHandles(),
    ratings,
    delegations,
    notes,
    rules: exportRules(
      options.bulkThreshold,
      options.cmsFieldsFile?.sha256 ?? null
    ),
    identity_sync: identitySync,
    ratings_changed_after_freeze: changedAfterFreeze,
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
      ratings_modified_after_freeze: ratingsChangedAfterFreeze,
      over_credit_raters_in_file: overInFile,
      over_credit_raters: overCredit.withXtdh,
      over_credit_raters_tdh_only: overCredit.tdhOnly,
      cic_differs_from_file_ratings: cicFromFile,
      multi_wallet_keys_without_identity: keysWithoutIdentity,
      extra_ids_missing: core.extraMissing.length,
      rating_edits_after_freeze: editsAfterFreeze,
      identity_sync_pending_generation: identitySync?.pendingGeneration ?? -1,
      identity_sync_synced_generation: identitySync?.syncedGeneration ?? -1,
      identity_sync_pending_block: identitySync?.pendingBlock ?? -1,
      identity_sync_full_write_block: identitySync?.fullWriteBlock ?? -1,
      bulk_categories: bulkCategories.length,
      bulk_ratings_left_out: scope.bulkLeftOut,
      profiles_left_out: excluded.size,
      outside_public_reach: outsideReach,
      delegations: delegations.length
    }
  };
}
