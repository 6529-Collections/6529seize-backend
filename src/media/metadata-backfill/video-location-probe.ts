import { MediaObjectStore } from './backfill-storage';

/** Bytes read from each end of a video: the `moov` box sits at one of them. */
export const VIDEO_PROBE_WINDOW_BYTES = 512 * 1024;

/**
 * Location markers in MP4/QuickTime metadata: the `©xyz` user-data atom
 * (Apple and Android), Apple's ISO 6709 metadata key, and GoPro's GPMF
 * telemetry track. Finding one means the video likely carries location.
 */
const LOCATION_MARKERS: readonly Buffer[] = [
  Buffer.from([0xa9, 0x78, 0x79, 0x7a]),
  Buffer.from('com.apple.quicktime.location.ISO6709', 'latin1'),
  Buffer.from('GPMF', 'latin1'),
  Buffer.from('gpmd', 'latin1')
];

export type VideoProbeResult =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'probed';
      readonly likelyLocation: boolean;
      readonly size: number;
    };

export function hasLocationMarker(bytes: Buffer): boolean {
  return LOCATION_MARKERS.some((marker) => bytes.includes(marker));
}

/** At most two bounded range reads per video; nothing is decoded or written. */
export async function probeVideoLocation(
  store: MediaObjectStore,
  key: string,
  windowBytes = VIDEO_PROBE_WINDOW_BYTES
): Promise<VideoProbeResult> {
  const head = await store.head(key);
  if (!head) return { kind: 'missing' };
  if (head.size === 0)
    return { kind: 'probed', likelyLocation: false, size: 0 };
  const firstEnd = Math.min(head.size, windowBytes) - 1;
  const first = await store.getRange(key, 0, firstEnd);
  if (hasLocationMarker(first)) {
    return { kind: 'probed', likelyLocation: true, size: head.size };
  }
  const tailStart = Math.max(firstEnd + 1, head.size - windowBytes);
  if (tailStart >= head.size) {
    return { kind: 'probed', likelyLocation: false, size: head.size };
  }
  // Overlap a few bytes so a marker split across the boundary is still found.
  const tail = await store.getRange(
    key,
    Math.max(0, tailStart - 64),
    head.size - 1
  );
  return {
    kind: 'probed',
    likelyLocation: hasLocationMarker(tail),
    size: head.size
  };
}
