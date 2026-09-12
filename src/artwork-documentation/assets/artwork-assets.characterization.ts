import { AssetTechnicalMetadata } from '@/artwork-documentation/assets/artwork-assets.types';
import { AssetInspectionError } from '@/artwork-documentation/assets/artwork-assets.inspection';

function wavProperties(bytes: Buffer): Record<string, string | number> {
  let offset = 12;
  const result: Record<string, string | number> = {};
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ' && length >= 16 && offset + 24 <= bytes.length) {
      result.codec_id = bytes.readUInt16LE(offset + 8);
      result.channels = bytes.readUInt16LE(offset + 10);
      result.sample_rate_hz = bytes.readUInt32LE(offset + 12);
      result.byte_rate = bytes.readUInt32LE(offset + 16);
      result.bit_depth = bytes.readUInt16LE(offset + 22);
    }
    if (id === 'data' && Number(result.byte_rate) > 0 && length !== 0xffffffff)
      result.duration_seconds = length / Number(result.byte_rate);
    offset += 8 + length + (length % 2);
  }
  return result;
}

function flacProperties(bytes: Buffer): Record<string, string | number> {
  if (bytes.length < 42 || (bytes[4] & 0x7f) !== 0) return {};
  const sampleRate = bytes.readUIntBE(18, 3) >>> 4;
  return {
    sample_rate_hz: sampleRate,
    channels: ((bytes[20] >> 1) & 7) + 1,
    bit_depth: (((bytes[20] & 1) << 4) | (bytes[21] >> 4)) + 1,
    ...(sampleRate
      ? {
          duration_seconds:
            ((bytes[21] & 15) * 2 ** 32 + bytes.readUInt32BE(22)) / sampleRate
        }
      : {})
  };
}

export function characterizeAssetHeader(
  bytes: Buffer,
  extension: string,
  size: number,
  sha256: string
): AssetTechnicalMetadata {
  const properties: AssetTechnicalMetadata['properties'] = {};
  if (['icc', 'icm'].includes(extension)) {
    if (bytes.readUInt32BE(0) !== size)
      throw new AssetInspectionError('INVALID_COLOR_PROFILE_SIZE');
    Object.assign(properties, {
      profile_version: `${bytes[8]}.${bytes[9] >> 4}.${bytes[9] & 15}`,
      profile_class: bytes.toString('ascii', 12, 16),
      color_space: bytes.toString('ascii', 16, 20).trim(),
      connection_space: bytes.toString('ascii', 20, 24).trim()
    });
  }
  if (extension === 'glb') {
    if (bytes.readUInt32LE(8) !== size)
      throw new AssetInspectionError('INVALID_GLB_SIZE');
    properties.container_version = bytes.readUInt32LE(4);
  }
  if (extension === 'wav') Object.assign(properties, wavProperties(bytes));
  if (extension === 'flac') Object.assign(properties, flacProperties(bytes));
  return {
    version: 1,
    characterization: 'partial',
    method: 'stream-header-inspector/1',
    detected_format: extension,
    format_registry: {
      status: 'unidentified',
      authority: null,
      identifier: null
    },
    original_sha256: sha256,
    measured_at: new Date().toISOString(),
    properties,
    warnings: [
      'FORMAT_REGISTRY_IDENTIFICATION_PENDING',
      'FULL_FORMAT_VALIDATION_NOT_PERFORMED'
    ],
    c2pa: { status: 'not_validated', original_bytes_preserved: true }
  };
}
