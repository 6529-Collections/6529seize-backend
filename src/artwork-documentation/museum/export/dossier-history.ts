import { parseJson } from '../../artwork-documentation.db';
import { digest } from '../../artwork-documentation.validation';
import { DossierIssue, DossierSnapshot } from './dossier.types';

export function containsRestrictedMaterial(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsRestrictedMaterial);
  const object = value as Record<string, unknown>;
  return (
    object.intended_visibility === 'restricted' ||
    (Array.isArray(object.restricted_paths) &&
      object.restricted_paths.length > 0) ||
    Object.values(object).some(containsRestrictedMaterial)
  );
}
export function publicationRevision(
  revision: Record<string, unknown>,
  issues: DossierIssue[]
) {
  const source = parseJson<unknown>(revision.snapshot_json);
  if (containsRestrictedMaterial(source)) {
    issues.push({
      code: 'HISTORICAL_CONFIRMATION_RETAINED_BY_HASH',
      path: `revision:${revision.id}`,
      severity: 'warning',
      message:
        'The historical confirmation includes restricted legacy material. Its digest is retained; those historical bytes are omitted from this publication dossier.'
    });
    return {
      id: revision.id,
      sha256: revision.sha256,
      source_draft_version: revision.source_draft_version,
      content_included: false
    };
  }
  if (digest(source) !== revision.sha256)
    throw new Error('Confirmed revision digest mismatch');
  return {
    ...revision,
    snapshot_json: source,
    confirmation_json: parseJson<unknown>(revision.confirmation_json),
    content_included: true
  };
}
function collectAssetReferences(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetReferences(item, ids));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      (key === 'asset_id' || key.endsWith('_asset_id')) &&
      typeof item === 'string'
    )
      ids.add(item);
    else if (
      (key === 'asset_ids' || key.endsWith('_asset_ids')) &&
      Array.isArray(item)
    )
      item
        .filter((id): id is string => typeof id === 'string')
        .forEach((id) => ids.add(id));
    else collectAssetReferences(item, ids);
  }
}
/** Keeps received evidence referenced by immutable history even after removal from the current draft. */
export function dossierAssetIds(
  context: DossierSnapshot['context'],
  revisions: Record<string, unknown>[],
  museumRecords: Record<string, unknown>[]
): Set<string> {
  const ids = new Set(context.asset_links.map((link) => link.asset_id));
  collectAssetReferences(context.modules, ids);
  for (const revision of revisions) {
    const source = parseJson<unknown>(revision.snapshot_json);
    if (!containsRestrictedMaterial(source))
      collectAssetReferences(source, ids);
  }
  for (const row of museumRecords)
    collectAssetReferences(parseJson<unknown>(row.payload_json), ids);
  return ids;
}
export function publicationHistory(
  snapshot: DossierSnapshot,
  issues: DossierIssue[]
) {
  const revisions =
    snapshot.artist_revisions ??
    (snapshot.confirmed_revision ? [snapshot.confirmed_revision] : []);
  const artist = revisions.map((revision) =>
    publicationRevision(revision, issues)
  );
  const included = new Set(
    artist
      .filter((revision) => revision.content_included)
      .map((revision) => revision.id)
  );
  const reviews = (snapshot.review_history ?? []).map((review) =>
    included.has(review.revision_id)
      ? {
          ...review,
          decision_history_json: parseJson<unknown>(
            review.decision_history_json ?? []
          )
        }
      : {
          revision_id: review.revision_id,
          lane: review.lane,
          sha256: digest(review),
          content_included: false
        }
  );
  return { artist_revisions: artist, review_history: reviews };
}
