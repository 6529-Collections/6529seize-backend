import { RESERVED_HANDLES } from '@/api/profiles/profiles.constants';
import { getLevelFromScore } from '@/profiles/profile-level';
import {
  IdentityExportSource,
  IdentityRow,
  StatementRow
} from './identity-export.db';
import { toMillis } from './identity-export.db';
import {
  BulkCategory,
  bulkKeys,
  compareCodePoints,
  compareRatings,
  findBulkCategories,
  isPlaceholderHandle,
  isRealHandle,
  publicExporterReach,
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
    classification: row.classification ?? null,
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
  const notes: string[] = [];

  const rowsByKey = new Map<string, IdentityRow>();
  const keyByProfile = new Map<string, string>();
  const tried = new Set<string>();
  const remember = (rows: IdentityRow[]) => {
    for (const row of rows) {
      rowsByKey.set(row.consolidation_key, row);
      if (row.p_external_id) {
        keyByProfile.set(
          row.p_external_id.toLowerCase(),
          row.consolidation_key
        );
      }
    }
  };

  // 1. The core: real handles, multi-wallet consolidations, the waves list.
  const realHandles = (await source.realHandleProfileIds()).map((it) =>
    it.toLowerCase()
  );
  remember(await source.identitiesByProfileIds(realHandles));
  realHandles.forEach((it) => tried.add(it));
  const multiWalletKeys = await source.multiWalletConsolidationKeys();
  remember(await source.identitiesByConsolidationKeys(multiWalletKeys));
  const extraIds = Array.from(
    new Set(options.extraProfileIds.map((it) => it.trim().toLowerCase()))
  ).filter((it) => it.length > 0);
  const extraToRead = extraIds.filter((it) => !keyByProfile.has(it));
  remember(await source.identitiesByProfileIds(extraToRead));
  extraToRead.forEach((it) => tried.add(it));
  const extraMissing = extraIds.filter((it) => !keyByProfile.has(it));
  if (extraMissing.length) {
    notes.push(
      `${extraMissing.length} waves-list profile ids have no identity or profile row: left out`
    );
  }
  const core = new Set<string>();
  realHandles.forEach((it) => core.add(it));
  extraIds.forEach((it) => core.add(it));
  for (const key of multiWalletKeys) {
    const profile = rowsByKey.get(key)?.p_external_id;
    if (profile) core.add(profile.toLowerCase());
  }
  log(
    `core: ${core.size} profiles (${realHandles.length} handles, ${multiWalletKeys.length} multi-wallet consolidations, ${extraIds.length} waves)`
  );

  // 2. Ratings, the bulk categories, and the profiles they bring in.
  const edges = (await source.ratingEdges()).map((edge) => ({
    ...edge,
    rater_profile_id: edge.rater_profile_id.toLowerCase(),
    target_profile_id: edge.target_profile_id.toLowerCase()
  }));
  const bulkCategories: BulkCategory[] = findBulkCategories(
    edges,
    options.bulkThreshold
  );
  const bulk = bulkKeys(bulkCategories);
  log(
    `ratings: ${edges.length} REP and CIC, ${bulkCategories.length} bulk categories`
  );
  const excluded = new Set<string>(extraMissing);
  let scope = selectRatingScope({ core, edges, bulk, excluded });
  for (;;) {
    const toRead = Array.from(scope.profiles).filter(
      (it) => !keyByProfile.has(it) && !tried.has(it)
    );
    if (toRead.length) {
      remember(await source.identitiesByProfileIds(toRead));
      toRead.forEach((it) => tried.add(it));
    }
    const notFound = Array.from(scope.profiles).filter(
      (it) => !keyByProfile.has(it)
    );
    if (!notFound.length) {
      break;
    }
    notFound.forEach((it) => excluded.add(it));
    scope = selectRatingScope({ core, edges, bulk, excluded });
  }
  const unresolved = Array.from(excluded).filter(
    (it) => !extraMissing.includes(it)
  );
  if (unresolved.length) {
    notes.push(
      `${unresolved.length} profiles named by ratings have no identity or profile row: left out with their ratings`
    );
  }
  if (bulkCategories.length) {
    notes.push(
      `${bulkCategories.length} given REP categories with more than ${options.bulkThreshold} targets bring no one in: ${scope.bulkLeftOut} of their ratings name a profile not otherwise in scope and are left out (see bulk_rep)`
    );
  }

  // 3. The identities: profiles in scope, and multi-wallet ones without one.
  const exportKeys = new Set<string>();
  scope.profiles.forEach((it) => exportKeys.add(keyByProfile.get(it)!));
  for (const key of multiWalletKeys) {
    const row = rowsByKey.get(key);
    if (row && !row.p_external_id) exportKeys.add(key);
  }
  const keys = Array.from(exportKeys).sort(compareCodePoints);
  const wallets = await source.walletsByConsolidationKeys(keys);
  const profileIds = keys
    .map((key) => rowsByKey.get(key)?.p_external_id?.toLowerCase())
    .filter((it): it is string => !!it);
  const statementsByProfile = new Map<string, IdentityExportStatement[]>();
  for (const row of await source.statementsByProfileIds(profileIds)) {
    const profile = row.profile_id.toLowerCase();
    const list = statementsByProfile.get(profile) ?? [];
    list.push(toStatement(row));
    statementsByProfile.set(profile, list);
  }
  const extraSet = new Set(extraIds);
  let walletsMissing = 0;
  const identities = keys
    .map((key) => {
      const row = rowsByKey.get(key)!;
      const profile = row.p_external_id?.toLowerCase() ?? null;
      const list = wallets.get(key) ?? [];
      if (!list.length) walletsMissing++;
      const labels: IdentityExportScope[] = [];
      if (profile && isRealHandle(row.p_handle)) labels.push('handle');
      if (list.length >= 2) labels.push('wallets');
      if (profile && scope.rated.has(profile)) labels.push('rating');
      if (profile && extraSet.has(profile)) labels.push('waves');
      return toExportIdentity(
        row,
        list,
        profile ? (statementsByProfile.get(profile) ?? []) : [],
        labels
      );
    })
    .filter((it) => it.scope.length > 0)
    .sort(compareIdentities);
  if (walletsMissing) {
    notes.push(
      `${walletsMissing} identities have no address_consolidation_keys row: their primary address is their one wallet`
    );
  }
  const placeholderStatements = identities.filter(
    (it) => isPlaceholderHandle(it.handle) && it.statements.length > 0
  ).length;
  if (placeholderStatements) {
    notes.push(
      `${placeholderStatements} exported profiles with a placeholder handle have statements (exported)`
    );
  }
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
  const reach = publicExporterReach({ core, edges, bulk });
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
