import { ChatMediaSource } from './chat-media-candidates';

/** Scan order: drop media, then wave pictures, then archived wave pictures. */
export const SCAN_PHASES: readonly ChatMediaSource[] = [
  ChatMediaSource.DROP_MEDIA,
  ChatMediaSource.WAVE_PICTURE,
  ChatMediaSource.ARCHIVED_WAVE_PICTURE
];

export interface ScanCursor {
  readonly phase: ChatMediaSource;
  /** Last fully handled id of that phase's table. */
  readonly after: number;
}

export function formatCursor(cursor: ScanCursor): string {
  return `${cursor.phase}:${cursor.after}`;
}

export function parseCursor(value: string): ScanCursor {
  const [phase, after] = value.split(':');
  const id = Number(after);
  const known = SCAN_PHASES.find((candidate) => candidate === phase);
  if (!known || !Number.isSafeInteger(id) || id < 0) {
    throw new Error(
      `Invalid cursor "${value}"; expected <${SCAN_PHASES.join('|')}>:<id>`
    );
  }
  return { phase: known, after: id };
}
