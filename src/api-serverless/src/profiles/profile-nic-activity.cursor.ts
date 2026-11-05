import { createHash } from 'node:crypto';
import { BadRequestException } from '@/exceptions';
import { ProfileNicActivityPosition } from '@/profileActivityLogs/profile-nic-activity.query';
import type { ProfileActivityLogsSearchRequest } from './profile-activity-logs-api.service';
import { RequestContext } from '@/request.context';

const INVALID_CURSOR = 'Invalid NIC activity cursor';

export function validateNicActivityRequest(
  request: ProfileActivityLogsSearchRequest
) {
  if (
    request.activityScope !== 'NIC' ||
    Boolean(request.profileId) === Boolean(request.targetId) ||
    request.group_id ||
    request.category ||
    request.ratingMatter ||
    request.order !== 'desc' ||
    !Number.isSafeInteger(request.pageRequest.page) ||
    request.pageRequest.page < 1 ||
    !Number.isSafeInteger(request.pageRequest.page_size) ||
    request.pageRequest.page_size < 1 ||
    request.pageRequest.page_size > 500
  ) {
    throw new BadRequestException(
      'NIC activity requires one profile, descending order and a page size from 1 to 500'
    );
  }
  if (request.pageRequest.page > 1 && !request.cursor)
    throw new BadRequestException(INVALID_CURSOR);
}

export function nicActivityContext(
  request: ProfileActivityLogsSearchRequest,
  ctx: RequestContext
) {
  // Bind to the read request and viewer, but still reauthorize every query.
  return createHash('sha256')
    .update(
      JSON.stringify({
        profile: request.profileId ?? null,
        target: request.targetId ?? null,
        incoming: request.includeProfileIdToIncoming,
        types: Array.from(new Set(request.logType ?? [])).sort((a, b) =>
          a.localeCompare(b)
        ),
        size: request.pageRequest.page_size,
        viewer: ctx.authenticationContext?.authenticatedProfileId ?? null,
        role: ctx.authenticationContext?.roleProfileId ?? null
      })
    )
    .digest('hex');
}

export function encodeNicActivityCursor(
  position: ProfileNicActivityPosition,
  context: string,
  page: number
) {
  // This unsigned position never grants access; every query reauthorizes rows.
  return Buffer.from(
    JSON.stringify({ v: 1, context, page, position })
  ).toString('base64url');
}

export function decodeNicActivityCursor(
  cursor: unknown,
  context: string,
  page: number
): ProfileNicActivityPosition | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    if (
      typeof cursor !== 'string' ||
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw new Error(INVALID_CURSOR);
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    );
    if (
      !isRecord(value) ||
      value.v !== 1 ||
      value.context !== context ||
      value.page !== page ||
      !isPosition(value.position)
    ) {
      throw new Error(INVALID_CURSOR);
    }
    return value.position;
  } catch {
    throw new BadRequestException(INVALID_CURSOR);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPosition(value: unknown): value is ProfileNicActivityPosition {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 100 &&
    (value.createdAt === null || isDatabaseTimestamp(value.createdAt))
  );
}

function isDatabaseTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    return false;
  const date = new Date(value.replace(' ', 'T') + 'Z');
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19).replace('T', ' ') === value
  );
}
