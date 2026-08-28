import { ApiProfileWaveActivityType } from '@/api/generated/models/ApiProfileWaveActivityType';
import type {
  CreatedProfileWaveActivityCursor,
  RecentProfileWaveActivityCursor
} from '@/api/waves/waves.api.db';
import { BadRequestException } from '@/exceptions';

const CURSOR_VERSION = 1;
const INVALID_CURSOR_MESSAGE = 'Invalid profile wave activity cursor';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CursorBase {
  readonly v: typeof CURSOR_VERSION;
  readonly activity_type: ApiProfileWaveActivityType;
  readonly target_profile_id: string;
}

interface CreatedCursorPayload extends CursorBase {
  readonly activity_type: ApiProfileWaveActivityType.Created;
  readonly sort: {
    readonly has_qualifying_post: number;
    readonly latest_post_timestamp: number;
    readonly wave_serial_no: number;
    readonly wave_id: string;
  };
}

interface RecentCursorPayload extends CursorBase {
  readonly activity_type: ApiProfileWaveActivityType.Recent;
  readonly sort: {
    readonly latest_post_timestamp: number;
    readonly wave_id: string;
  };
}

export class ProfileWaveActivityCursorCodec {
  public encodeCreated(
    targetProfileId: string,
    cursor: CreatedProfileWaveActivityCursor
  ): string {
    return this.encode({
      v: CURSOR_VERSION,
      activity_type: ApiProfileWaveActivityType.Created,
      target_profile_id: targetProfileId,
      sort: {
        has_qualifying_post: cursor.hasQualifyingPost,
        latest_post_timestamp: cursor.latestPostTimestamp,
        wave_serial_no: cursor.waveSerialNo,
        wave_id: cursor.waveId
      }
    });
  }

  public encodeRecent(
    targetProfileId: string,
    cursor: RecentProfileWaveActivityCursor
  ): string {
    return this.encode({
      v: CURSOR_VERSION,
      activity_type: ApiProfileWaveActivityType.Recent,
      target_profile_id: targetProfileId,
      sort: {
        latest_post_timestamp: cursor.latestPostTimestamp,
        wave_id: cursor.waveId
      }
    });
  }

  public decodeCreated(
    cursor: string | undefined,
    targetProfileId: string
  ): CreatedProfileWaveActivityCursor | null {
    if (!cursor) {
      return null;
    }
    const payload = this.decode(cursor);
    if (
      payload.v !== CURSOR_VERSION ||
      payload.activity_type !== ApiProfileWaveActivityType.Created ||
      payload.target_profile_id !== targetProfileId ||
      !this.isRecord(payload.sort)
    ) {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
    const hasQualifyingPost = payload.sort.has_qualifying_post;
    const latestPostTimestamp = payload.sort.latest_post_timestamp;
    const waveSerialNo = payload.sort.wave_serial_no;
    const waveId = payload.sort.wave_id;
    if (
      (hasQualifyingPost !== 0 && hasQualifyingPost !== 1) ||
      !this.isSafeNonNegativeInteger(latestPostTimestamp) ||
      !this.isSafePositiveInteger(waveSerialNo) ||
      !this.isWaveId(waveId) ||
      (hasQualifyingPost === 0 && latestPostTimestamp !== 0) ||
      (hasQualifyingPost === 1 && latestPostTimestamp === 0)
    ) {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
    return {
      hasQualifyingPost,
      latestPostTimestamp,
      waveSerialNo,
      waveId
    };
  }

  public decodeRecent(
    cursor: string | undefined,
    targetProfileId: string
  ): RecentProfileWaveActivityCursor | null {
    if (!cursor) {
      return null;
    }
    const payload = this.decode(cursor);
    if (
      payload.v !== CURSOR_VERSION ||
      payload.activity_type !== ApiProfileWaveActivityType.Recent ||
      payload.target_profile_id !== targetProfileId ||
      !this.isRecord(payload.sort)
    ) {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
    const latestPostTimestamp = payload.sort.latest_post_timestamp;
    const waveId = payload.sort.wave_id;
    if (
      !this.isSafePositiveInteger(latestPostTimestamp) ||
      !this.isWaveId(waveId)
    ) {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
    return { latestPostTimestamp, waveId };
  }

  private encode(payload: CreatedCursorPayload | RecentCursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  private decode(cursor: string): Record<string, unknown> {
    try {
      if (!BASE64URL_PATTERN.test(cursor)) {
        throw new Error(INVALID_CURSOR_MESSAGE);
      }
      const json = Buffer.from(cursor, 'base64url').toString('utf8');
      const decoded = JSON.parse(json) as unknown;
      if (!this.isRecord(decoded)) {
        throw new Error(INVALID_CURSOR_MESSAGE);
      }
      return decoded;
    } catch {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private isSafePositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
  }

  private isSafeNonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  private isWaveId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 100;
  }
}

export const profileWaveActivityCursorCodec =
  new ProfileWaveActivityCursorCodec();
