import { randomUUID } from 'node:crypto';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';

const SNAPSHOT_TTL = Time.minutes(15);
// About 2 MB of UUIDs per snapshot. Reject rather than silently omit memberships.
const MAX_SNAPSHOT_WAVES = 50000;
const snapshotUnavailable = () =>
  new CustomApiCompliantException(
    503,
    'Joined waves are temporarily unavailable. Please retry.',
    'JOINED_WAVE_SNAPSHOT_UNAVAILABLE'
  );
const CURSOR_PATTERN =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})\.(\d{1,3})$/;

export interface JoinedWaveSnapshot {
  readonly id: string;
  readonly waveIds: string[];
  readonly pageSize: number;
  readonly expiresAt: number;
}

export interface JoinedWaveCursor {
  readonly snapshotId: string;
  readonly offset: number;
  readonly pageSize: number;
}

export function encodeJoinedWaveCursor(
  snapshot: JoinedWaveSnapshot,
  offset: number
): string {
  return `v1.${snapshot.id}.${offset}.${snapshot.pageSize}`;
}

export function decodeJoinedWaveCursor(cursor: string): JoinedWaveCursor {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new BadRequestException('Invalid joined wave cursor');
  return {
    snapshotId: match[1],
    offset: Number(match[2]),
    pageSize: Number(match[3])
  };
}

const snapshotKey = (profileId: string, snapshotId: string) =>
  `joined_wave_snapshot_v1:${profileId}:${snapshotId}`;

export class JoinedWaveSnapshotStore {
  public async create(
    profileId: string,
    waveIds: string[],
    pageSize: number
  ): Promise<JoinedWaveSnapshot> {
    if (waveIds.length > MAX_SNAPSHOT_WAVES) {
      throw snapshotUnavailable();
    }
    const snapshot: JoinedWaveSnapshot = {
      id: randomUUID(),
      waveIds,
      pageSize,
      expiresAt: Date.now() + SNAPSHOT_TTL.toMillis()
    };
    // A complete first page has no continuation and needs no shared storage.
    if (waveIds.length <= pageSize) return snapshot;
    const key = snapshotKey(profileId, snapshot.id);
    try {
      await redisSetJson(key, snapshot, SNAPSHOT_TTL);
      // Cache helpers may fail open. Never return an unsaved continuation.
      const stored = await redisGet<JoinedWaveSnapshot>(key);
      if (stored?.id !== snapshot.id) throw snapshotUnavailable();
    } catch {
      throw snapshotUnavailable();
    }
    return snapshot;
  }

  public async read(
    profileId: string,
    cursor: JoinedWaveCursor
  ): Promise<JoinedWaveSnapshot> {
    let snapshot: JoinedWaveSnapshot | null;
    try {
      snapshot = await redisGet<JoinedWaveSnapshot>(
        snapshotKey(profileId, cursor.snapshotId)
      );
    } catch {
      throw snapshotUnavailable();
    }
    if (!snapshot || snapshot.expiresAt <= Date.now()) {
      throw new CustomApiCompliantException(
        410,
        'Joined wave list expired. Refresh the list to continue.',
        'JOINED_WAVE_SNAPSHOT_EXPIRED'
      );
    }
    if (
      snapshot.pageSize !== cursor.pageSize ||
      cursor.offset >= snapshot.waveIds.length
    ) {
      throw new BadRequestException('Invalid joined wave cursor');
    }
    return snapshot;
  }
}

export const joinedWaveSnapshotStore = new JoinedWaveSnapshotStore();
