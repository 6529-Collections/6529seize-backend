import { createHash } from 'node:crypto';
import type {
  MemeClaimAnimationDetails,
  MemeClaimAnimationDetailsGlb,
  MemeClaimAnimationDetailsVideo,
  MemeClaimImageDetails
} from '@/entities/IMemeClaim';
import fetch from 'node-fetch';
import { imageSize } from 'image-size';
import * as MP4Box from 'mp4box';

type MediaKind = 'image' | 'video' | 'glb';

function sniffKindAndFormat(
  contentType: string | null,
  url: string
): { kind: MediaKind; format: string } {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const path = new URL(url, 'https://dummy').pathname.toLowerCase();
  if (ct === 'model/gltf-binary' || path.endsWith('.glb'))
    return { kind: 'glb', format: 'GLB' };
  if (ct === 'video/mp4' || path.endsWith('.mp4'))
    return { kind: 'video', format: 'MP4' };
  if (ct === 'video/quicktime' || path.endsWith('.mov'))
    return { kind: 'video', format: 'MOV' };
  if (ct === 'image/png' || path.endsWith('.png'))
    return { kind: 'image', format: 'PNG' };
  if (ct === 'image/jpeg' || path.endsWith('.jpg') || path.endsWith('.jpeg'))
    return { kind: 'image', format: 'JPG' };
  if (ct === 'image/gif' || path.endsWith('.gif'))
    return { kind: 'image', format: 'GIF' };
  if (ct === 'image/webp' || path.endsWith('.webp'))
    return { kind: 'image', format: 'WEBP' };
  throw new Error(
    `Unsupported media type (content-type: ${ct || 'unknown'}, url: ${url})`
  );
}

async function fetchUrlToBuffer(
  url: string
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type');
  return { buffer, contentType };
}

function extractImageDetailsFromBuffer(
  buffer: Buffer,
  format: string
): MemeClaimImageDetails {
  const size = imageSize(buffer);
  if (!size?.width || !size?.height) {
    throw new Error('Could not read image dimensions');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return {
    bytes: buffer.length,
    format,
    sha256,
    width: size.width,
    height: size.height
  };
}

function extractVideoDetailsFromBuffer(
  buffer: Buffer,
  format: string
): Promise<MemeClaimAnimationDetailsVideo> {
  return new Promise((resolve, reject) => {
    const mp4boxFile = MP4Box.createFile();
    mp4boxFile.onError = (e: unknown) =>
      reject(new Error(`mp4box parse error: ${String(e)}`));
    mp4boxFile.onReady = (info: {
      duration?: number;
      timescale?: number;
      tracks?: Array<{
        type?: string;
        video?: { width?: number; height?: number };
        track_width?: number;
        track_height?: number;
        codec?: string;
      }>;
    }) => {
      const videoTrack = (info?.tracks ?? []).find(
        (t: { video?: unknown }) => t.video != null
      );
      if (!videoTrack) {
        reject(new Error('No video track found'));
        return;
      }
      const width = videoTrack.video?.width ?? videoTrack.track_width ?? 0;
      const height = videoTrack.video?.height ?? videoTrack.track_height ?? 0;
      if (!width || !height) {
        reject(new Error('Could not read video dimensions'));
        return;
      }
      const dur = Number(info?.duration ?? 0);
      const ts = Number(info?.timescale ?? 0);
      const duration = dur > 0 && ts > 0 ? dur / ts : 0;
      const codecs = (info?.tracks ?? [])
        .map((t) => t.codec)
        .filter((c): c is string => typeof c === 'string' && c.length > 0);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      resolve({
        bytes: buffer.length,
        format,
        duration,
        sha256,
        width,
        height,
        codecs:
          codecs.length > 0 ? Array.from(new Set(codecs)) : ['H.264', 'AAC']
      });
    };
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    const mp4buf = ab as ArrayBuffer & { fileStart: number };
    mp4buf.fileStart = 0;
    mp4boxFile.appendBuffer(mp4buf as never);
    mp4boxFile.flush();
  });
}

function extractGlbDetailsFromBuffer(
  buffer: Buffer
): MemeClaimAnimationDetailsGlb {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return {
    bytes: buffer.length,
    format: 'GLB',
    sha256
  };
}

export async function computeImageDetails(
  imageUrl: string
): Promise<MemeClaimImageDetails> {
  const { buffer, contentType } = await fetchUrlToBuffer(imageUrl);
  const { kind, format } = sniffKindAndFormat(contentType, imageUrl);
  if (kind !== 'image') {
    throw new Error(`Expected image, got ${kind}`);
  }
  return extractImageDetailsFromBuffer(buffer, format);
}

export function animationDetailsHtml(): MemeClaimAnimationDetails {
  return { format: 'HTML' };
}

export async function computeAnimationDetailsGlb(
  url: string
): Promise<MemeClaimAnimationDetails> {
  const { buffer, contentType } = await fetchUrlToBuffer(url);
  const { kind } = sniffKindAndFormat(contentType, url);
  if (kind !== 'glb') {
    throw new Error(`Expected GLB, got ${kind}`);
  }
  return extractGlbDetailsFromBuffer(buffer);
}

export async function computeAnimationDetailsVideo(
  videoUrl: string
): Promise<MemeClaimAnimationDetails> {
  const { buffer, contentType } = await fetchUrlToBuffer(videoUrl);
  const { kind, format } = sniffKindAndFormat(contentType, videoUrl);
  if (kind !== 'video') {
    throw new Error(`Expected video, got ${kind}`);
  }
  return extractVideoDetailsFromBuffer(buffer, format);
}
