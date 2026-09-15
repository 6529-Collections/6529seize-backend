import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException } from '@/exceptions';
import { GetNftMarketActivityQuery } from '@/api/generated/routes/operations';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID = /^(0|[1-9]\d{0,77})$/;
const pageSize = Joi.number().integer().min(1).max(100).default(50);
const cursor = Joi.string().max(2048);

export function validateDepthPath(input: unknown) {
  return getValidatedByJoiOrThrow<{ contract: string; token_id: string }>(
    input,
    Joi.object({
      contract: Joi.string().pattern(ADDRESS).lowercase().required(),
      token_id: Joi.string().pattern(TOKEN_ID).required()
    })
  );
}

export function validateDepthQuery(input: unknown) {
  return getValidatedByJoiOrThrow<{ page_size: number; cursor?: string }>(
    input,
    Joi.object({ page_size: pageSize, cursor })
  );
}

export function validateActivityQuery(input: unknown) {
  const result = getValidatedByJoiOrThrow<GetNftMarketActivityQuery>(
    input,
    Joi.object({
      contract: Joi.string().max(1500),
      token_id: Joi.string().pattern(TOKEN_ID),
      wallet: Joi.string().max(2000),
      filter: Joi.string()
        .valid(
          'all',
          'sales',
          'purchases',
          'mints',
          'airdrops',
          'transfers',
          'burns',
          'listings',
          'offers',
          'cancellations',
          'expirations',
          'invalidations',
          'revalidations'
        )
        .default('all'),
      page_size: pageSize,
      cursor
    })
  );
  if (result.token_id && (!result.contract || result.contract.includes(','))) {
    throw new BadRequestException('A token ID requires exactly one contract');
  }
  return result;
}

export function decodeMarketCursor<T>(cursor: string): T {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid encoding');
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    );
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('Invalid cursor object');
    }
    return parsed as T;
  } catch {
    throw new BadRequestException('Invalid market cursor');
  }
}

export function encodeMarketCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
