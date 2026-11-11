import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ApiCommunityMemorySource } from '@/api/generated/models/ApiCommunityMemorySource';
import { ApiCommunityMemorySourceClassification } from '@/api/generated/models/ApiCommunityMemorySourceClassification';
import { ApiCommunityMemorySourceKind } from '@/api/generated/models/ApiCommunityMemorySourceKind';
import { ApiCommunityMemorySourcePage } from '@/api/generated/models/ApiCommunityMemorySourcePage';
import { ListCommunityMemorySourcesRequest } from '@/api/generated/routes/operations';
import { BadRequestException } from '@/exceptions';
import {
  CommunityMemorySourceCursor,
  CommunityMemorySourceRow,
  NewsletterEditionSourcesDb,
  newsletterEditionSourcesDb
} from '@/newsletter/newsletter-edition-sources.db';
import { TEAM_WAVE_IDS } from '@/newsletter/newsletter.config';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';

export const COMMUNITY_MEMORY_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const EPOCH_MILLIS = /^\d{1,15}$/;
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

interface SourcesQuery {
  readonly wave_id?: string;
  readonly edition_id?: string;
  readonly from?: number;
  readonly to?: number;
  readonly cursor?: string;
  readonly limit: number;
}

/** ISO-8601 or epoch milliseconds; anything else is a 400. */
function parseTime(
  value: unknown,
  helpers: Joi.CustomHelpers
): number | Joi.ErrorReport {
  const text = String(value).trim();
  let time = Number.NaN;
  if (EPOCH_MILLIS.test(text)) time = Number(text);
  else if (ISO_8601.test(text)) time = Date.parse(text);
  if (!Number.isFinite(time) || time < 0) {
    return helpers.error('any.invalid');
  }
  return time;
}

const SourcesQuerySchema = Joi.object<SourcesQuery>({
  wave_id: Joi.string().trim().min(1).max(100).optional(),
  edition_id: Joi.string().trim().min(1).max(100).optional(),
  from: Joi.string().trim().min(1).max(40).custom(parseTime).optional(),
  to: Joi.string().trim().min(1).max(40).custom(parseTime).optional(),
  cursor: Joi.string().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(100).default(50)
})
  .unknown(false)
  .required();

type CursorPayload = { readonly v: 1; readonly t: number; readonly s: string };

export function encodeSourceCursor(
  cursor: CommunityMemorySourceCursor
): string {
  const payload: CursorPayload = { v: 1, t: cursor.time, s: cursor.sourceId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeSourceCursor(
  cursor: string | undefined
): CommunityMemorySourceCursor | undefined {
  if (!cursor) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as Partial<CursorPayload>;
    if (
      payload.v !== 1 ||
      !Number.isSafeInteger(payload.t) ||
      typeof payload.s !== 'string' ||
      !payload.s
    ) {
      throw new Error('Cursor does not match this request');
    }
    return { time: payload.t!, sourceId: payload.s };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function validateWindow(query: SourcesQuery): void {
  if (query.from === undefined || query.to === undefined) return;
  if (query.to <= query.from) {
    throw new BadRequestException('to must be after from');
  }
  if (query.to - query.from > COMMUNITY_MEMORY_MAX_WINDOW_MS) {
    throw new BadRequestException('from/to window may span at most 31 days');
  }
}

/**
 * WINNER and MINT records are outcomes; drops in 6529 team waves are
 * announcements; other drops are discussion. Identities carry none.
 */
export function classifySource(
  row: Pick<CommunityMemorySourceRow, 'kind' | 'wave_id'>
): ApiCommunityMemorySourceClassification | null {
  switch (row.kind) {
    case 'WINNER':
    case 'MINT':
      return ApiCommunityMemorySourceClassification.Outcome;
    case 'DROP':
      return row.wave_id && TEAM_WAVE_IDS.includes(row.wave_id)
        ? ApiCommunityMemorySourceClassification.Announcement
        : ApiCommunityMemorySourceClassification.Discussion;
    default:
      return null;
  }
}

export function toApiCommunityMemorySource(
  row: CommunityMemorySourceRow
): ApiCommunityMemorySource {
  return {
    source_id: row.source_id,
    kind: row.kind as ApiCommunityMemorySourceKind,
    canonical_url: row.canonical_url,
    title: row.title,
    author_handle: row.author_handle,
    wave_id: row.wave_id,
    wave_name: row.wave_name,
    observed_at: new Date(row.collected_at).toISOString(),
    time: new Date(row.time).toISOString(),
    content_fingerprint: row.content_fingerprint,
    provenance: {
      edition_id: row.edition_id,
      collected_at: new Date(row.collected_at).toISOString()
    },
    classification: classifySource(row)
  };
}

export async function listCommunityMemorySources(
  query: SourcesQuery,
  ctx: RequestContext,
  db: Pick<NewsletterEditionSourcesDb, 'listPublicSources'>
): Promise<ApiCommunityMemorySourcePage> {
  validateWindow(query);
  const after = decodeSourceCursor(query.cursor);
  const rows = await db.listPublicSources(
    {
      waveId: query.wave_id,
      editionId: query.edition_id,
      from: query.from,
      to: query.to,
      after,
      limit: query.limit + 1
    },
    ctx
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > query.limit;
  return {
    data: page.map(toApiCommunityMemorySource),
    next_cursor:
      hasMore && last
        ? encodeSourceCursor({ time: last.time, sourceId: last.source_id })
        : null,
    has_more: hasMore
  };
}

export async function handleListCommunityMemorySources(
  req: ListCommunityMemorySourcesRequest
): Promise<ApiCommunityMemorySourcePage> {
  const query = getValidatedByJoiOrThrow(req.query, SourcesQuerySchema);
  return listCommunityMemorySources(
    query,
    { timer: Timer.getFromRequest(req) },
    newsletterEditionSourcesDb
  );
}
