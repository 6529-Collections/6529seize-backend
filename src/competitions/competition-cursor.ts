import { createHash } from 'node:crypto';
import { BadRequestException } from '@/exceptions';

type CursorPayload = {
  readonly v: 1;
  readonly scope: string;
  readonly fingerprint: string;
  readonly offset: number;
};

function fingerprint(filters: unknown): string {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}

export class CompetitionCursorCodec {
  public encode(scope: string, filters: unknown, offset: number): string {
    const payload: CursorPayload = {
      v: 1,
      scope,
      fingerprint: fingerprint(filters),
      offset
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  public decode(
    cursor: string | undefined,
    scope: string,
    filters: unknown
  ): number {
    if (!cursor) return 0;
    try {
      const payload = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8')
      ) as Partial<CursorPayload>;
      if (
        payload.v !== 1 ||
        payload.scope !== scope ||
        payload.fingerprint !== fingerprint(filters) ||
        !Number.isSafeInteger(payload.offset) ||
        (payload.offset ?? -1) < 0
      ) {
        throw new Error('Cursor does not match this request');
      }
      return payload.offset!;
    } catch {
      throw new BadRequestException('Invalid competition cursor');
    }
  }
}

export const competitionCursorCodec = new CompetitionCursorCodec();
