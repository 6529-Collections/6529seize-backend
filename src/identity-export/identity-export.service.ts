import { RESERVED_HANDLES } from '@/api/profiles/profiles.constants';
import { getLevelFromScore } from '@/profiles/profile-level';
import { ProfileClassification } from '@/entities/IProfile';
import { enums } from '@/enums';
import {
  IdentityExportSource,
  IdentityRow,
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
  readonly freezeMs: number | null;
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
  const levelRaw =
    row.level_raw === null || row.level_raw === undefined
      ? null
      : numberOr(row.level_raw, 0);
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
    tdh: numberOr(row.tdh, 0),
    xtdh: numberOr(row.xtdh, 0),
    rep: Math.trunc(numberOr(row.rep, 0)),
    cic: Math.trunc(numberOr(row.cic, 0)),
    level: getLevelFromScore(levelRaw ?? 0),
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

  const index = new IdentityIndex(source);
  const core = await readCore(source, index, options.extraProfileIds);
  log(
    `core: ${core.profiles.size} profiles (${core.multiWalletKeys.length} multi-wallet consolidations, ${core.extraIds.length} waves)`
  );

  const edges = (await source.ratingEdges()).map((edge) => ({
    ...edge,
    rater_profile_id: edge.rater_profile_id.toLowerCase(),
    target_profile_id: edge.target_profile_id.toLowerCase()
  }));
  const bulkCategories = findBulkCategories(edges, options.bulkThreshold);
  const bulk = bulkKeys(bulkCategories);
  log(
    `ratings: ${edges.length} REP and CIC, ${bulkCategories.length} bulk categories`
  );
  const { scope, excluded } = await resolveScope(index, core, edges, bulk);
  const built = await buildIdentities(source, index, core, scope);
  const identities = built.identities;
  const notes = [
    ...(options.wavesListGiven === false
      ? [
          'no --extra-ids: profiles in scope only for waves activity (drops, entries, waves, votes, wave ratings, group lists) are not included'
        ]
      : []),
    ...scopeNotes(core, excluded, bulkCategories, options.bulkThreshold, scope),
    ...built.notes
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

  const tdhBlock = await source.latestTdhBlock();
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
      ratings_read: edges.length,
      bulk_categories: bulkCategories.length,
      bulk_ratings_left_out: scope.bulkLeftOut,
      profiles_left_out: excluded.size,
      outside_public_reach: outsideReach,
      delegations: delegations.length
    }
  };
}
