import { createHash } from 'node:crypto';
import { BadRequestException } from '@/exceptions';
import { ProfileNicActivityPosition } from '@/profileActivityLogs/profile-nic-activity.query';
import type { ProfileActivityLogsSearchRequest } from './profile-activity-logs-api.service';
import { RequestContext } from '@/request.context';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { PageRequest } from '@/api/page-request';

const INVALID_CURSOR = 'Invalid NIC activity cursor';
const NIC_QUERY_SCHEMA = Joi.object({
  activity_scope: Joi.valid('NIC').required(),
  profile: Joi.string().empty(''),
  target: Joi.string().empty(''),
  group_id: Joi.valid(''),
  category: Joi.valid(''),
  rating_matter: Joi.valid(''),
  order: Joi.string().empty('').lowercase().valid('desc'),
  page: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  page_size: Joi.number().integer().min(1).max(500).default(50),
  cursor: Joi.string()
    .empty('')
    .when('page', {
      is: Joi.number().greater(1),
      then: Joi.required()
    })
})
  .xor('profile', 'target')
  .pattern(Joi.string(), Joi.string().allow(''));
const NIC_CURSOR_SCHEMA = Joi.object<{
  v: 1;
  context: string;
  page: number;
  position: ProfileNicActivityPosition;
}>({
  v: Joi.valid(1).required(),
  context: Joi.string().required(),
  page: Joi.number().integer().positive().required(),
  position: Joi.object<ProfileNicActivityPosition>({
    id: Joi.string().max(100).required(),
    createdAt: Joi.string()
      .custom((value: string, helpers) =>
        isDatabaseTimestamp(value) ? value : helpers.error('any.invalid')
      )
      .allow(null)
      .required()
  }).required()
}).prefs({ convert: false, allowUnknown: true });

export function getNicActivityPageRequest(
  query: Record<string, unknown>
): PageRequest | null {
  if (query.activity_scope === undefined) {
    if (query.cursor)
      throw new BadRequestException('A NIC cursor requires activity_scope=NIC');
    return null;
  }
  const { page, page_size } = getValidatedByJoiOrThrow<PageRequest>(
    query,
    NIC_QUERY_SCHEMA
  );
  return { page, page_size };
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
    const value = getValidatedByJoiOrThrow(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
      NIC_CURSOR_SCHEMA
    );
    if (value.context !== context || value.page !== page)
      throw new Error(INVALID_CURSOR);
    return value.position;
  } catch {
    throw new BadRequestException(INVALID_CURSOR);
  }
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
