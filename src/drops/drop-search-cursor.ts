import { BadRequestException } from '@/exceptions';

export const MAX_GLOBAL_SEARCH_PAGE = 100;
export const GLOBAL_SEARCH_QUERY_BUDGET_MS = 3000;

export interface DropSearchCursor {
  readonly created_at: number;
  readonly id: string;
}

export function encodeDropSearchCursor(cursor: DropSearchCursor): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.created_at, id: cursor.id })
  ).toString('base64url');
}

export function decodeDropSearchCursor(encoded: string): DropSearchCursor {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as Partial<DropSearchCursor> | null;
    if (
      value &&
      Number.isSafeInteger(value.created_at) &&
      value.created_at! >= 0 &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      value.id.length <= 100
    ) {
      return { created_at: value.created_at!, id: value.id };
    }
  } catch {
    // Invalid opaque cursors are a client error, never a database parameter.
  }
  throw new BadRequestException('Invalid search cursor');
}
