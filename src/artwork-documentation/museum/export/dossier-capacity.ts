import { RequestContext } from '@/request.context';
import { ArtworkDocumentationDb } from '../../artwork-documentation.db';
import {
  AD_MUSEUM_RECORDS,
  AD_REVISIONS,
  AD_REVIEWS,
  AD_SOURCES
} from '../../artwork-documentation.tables';
import { fail } from '../../artwork-documentation.validation';
import { ARTWORK_ASSETS_TABLE } from '../../assets/artwork-assets.types';

export const DOSSIER_SNAPSHOT_BYTES = 32 * 1024 ** 2;
export interface DossierSelection {
  from: string;
  where: string;
  columns: readonly string[];
  jsonColumns?: readonly string[];
  limit: number;
  order: string;
}
const scoped = { where: 'context_id=:id' };
export const DOSSIER_HISTORY_SELECTIONS = {
  museum: {
    ...scoped,
    from: AD_MUSEUM_RECORDS,
    limit: 10000,
    order: 'created_at,id',
    columns: [
      'id',
      'context_id',
      'actor_profile_id',
      'kind',
      'supersedes_id',
      'source_revision_id',
      'source_draft_version',
      'payload_json',
      'sha256',
      'created_at'
    ],
    jsonColumns: ['payload_json']
  },
  sources: {
    ...scoped,
    from: AD_SOURCES,
    limit: 10000,
    order: 'id',
    columns: ['id', 'drop_id', 'receipt_text', 'sha256', 'is_excerpt']
  },
  revisions: {
    ...scoped,
    from: AD_REVISIONS,
    limit: 1000,
    order: 'revision_number,id',
    columns: [
      'id',
      'revision_number',
      'source_draft_version',
      'snapshot_json',
      'confirmation_json',
      'sha256',
      'created_at'
    ],
    jsonColumns: ['snapshot_json', 'confirmation_json']
  },
  reviews: {
    from: `${AD_REVIEWS} v JOIN ${AD_REVISIONS} r ON r.id=v.revision_id`,
    where: 'r.context_id=:id',
    limit: 10000,
    order: 'r.revision_number,v.lane',
    columns: [
      'v.revision_id',
      'v.lane',
      'v.review_version',
      'v.status',
      'v.reviewer_profile_id',
      'v.reason',
      'v.updated_at',
      'v.decision_history_json'
    ],
    jsonColumns: ['v.decision_history_json']
  }
} satisfies Record<string, DossierSelection>;

export const DOSSIER_ASSET_SELECTION: DossierSelection = {
  from: ARTWORK_ASSETS_TABLE,
  where: 'context_id=:id AND id IN (:assetIds)',
  limit: 1000,
  order: 'id',
  columns: [
    'id',
    'context_id',
    'uploader_profile_id',
    'request_key',
    'request_hash',
    'filename',
    'declared_mime',
    'extension',
    'role',
    'access_class',
    'intended_visibility',
    'state',
    'size_bytes',
    'reserved_bytes',
    'bucket',
    'object_key',
    'object_version',
    'multipart_id',
    'parts_json',
    'sha256',
    'detected_mime',
    'inspection_status',
    'scan_status',
    'preview_key',
    'width',
    'height',
    'failure_code',
    'referenced',
    'created_at',
    'updated_at',
    'expires_at',
    'next_attempt_at',
    'lease_until',
    'attempts',
    'technical_metadata_json',
    'validation_report_key'
  ]
};

/** Measure escaped row representations in SQL before materializing large JSON/text in the API process. */
export async function dossierSelectionBytes(
  db: ArtworkDocumentationDb,
  selection: DossierSelection,
  params: Record<string, unknown>,
  ctx: RequestContext
): Promise<number> {
  const count = await db.one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${selection.from} WHERE ${selection.where}`,
    params,
    ctx
  );
  if (Number(count?.count ?? 0) > selection.limit)
    fail(413, 'DOSSIER_RECORD_LIMIT');
  const pairs = selection.columns.map((column) => {
    const value = selection.jsonColumns?.includes(column)
      ? `CAST(${column} AS CHAR CHARACTER SET utf8mb4)`
      : column;
    return `'${column.split('.').pop()}',${value}`;
  });
  const size = await db.one<{ bytes: number }>(
    `SELECT COALESCE(SUM(OCTET_LENGTH(JSON_OBJECT(${pairs.join(',')}))),0) AS bytes FROM ${selection.from} WHERE ${selection.where}`,
    params,
    ctx
  );
  // Account for array separators and the driver's SQL tinyint-to-boolean conversion.
  return Number(size?.bytes ?? 0) + Number(count?.count ?? 0) * 32 + 2;
}

export function requireDossierBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes > DOSSIER_SNAPSHOT_BYTES)
    fail(413, 'DOSSIER_RECORD_LIMIT');
}

export function dossierSelectionSql(selection: DossierSelection): string {
  return `SELECT ${selection.columns.join(',')} FROM ${selection.from} WHERE ${selection.where} ORDER BY ${selection.order} LIMIT ${selection.limit + 1}`;
}
