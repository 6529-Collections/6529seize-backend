import { createHash } from 'node:crypto';
import type { AssetTechnicalMetadata } from '@/artwork-documentation/assets/artwork-assets.types';

export const LINKED_TECHNICAL_METADATA_BYTES = 4096;

/** Keep context/revision snapshots bounded; authoritative measurements and inventories remain in asset storage/export. */
export function summarizeTechnicalMetadata(
  raw: string
): AssetTechnicalMetadata {
  const full = JSON.parse(raw) as AssetTechnicalMetadata;
  const { archive } = full;
  const retained: AssetTechnicalMetadata['properties'] = {
    technical_metadata_summary: true,
    technical_metadata_json_sha256: createHash('sha256')
      .update(raw, 'utf8')
      .digest('hex'),
    technical_metadata_json_bytes: Buffer.byteLength(raw, 'utf8')
  };
  if (archive)
    Object.assign(retained, {
      archive_entries: archive.entries,
      archive_expanded_bytes: archive.expanded_bytes,
      archive_inventory_sha256: createHash('sha256')
        .update(JSON.stringify(archive.inventory), 'utf8')
        .digest('hex'),
      archive_inventory_json_bytes: Buffer.byteLength(
        JSON.stringify(archive.inventory),
        'utf8'
      )
    });
  const summary: AssetTechnicalMetadata = {
    version: 1,
    characterization: full.characterization,
    method: shortText(full.method),
    detected_format: shortText(full.detected_format),
    original_sha256: shortText(full.original_sha256),
    measured_at: shortText(full.measured_at),
    format_registry:
      Buffer.byteLength(JSON.stringify(full.format_registry)) <= 512
        ? full.format_registry
        : { status: 'unidentified', authority: null, identifier: null },
    c2pa: { status: full.c2pa.status, original_bytes_preserved: true },
    properties: { ...retained },
    warnings: []
  };
  const credentials = [
    'integrity',
    'trust',
    'media_sha256',
    'report_sha256',
    'report_size_bytes',
    'settings_sha256',
    'validator',
    'validator_version',
    'remote_fetch',
    'error_code'
  ] as const;
  for (const key of credentials) {
    const value = full.c2pa[key];
    if (
      value === undefined ||
      (typeof value === 'string' && Buffer.byteLength(value) > 160)
    )
      continue;
    const candidate = { ...summary.c2pa, [key]: value };
    if (fits({ ...summary, c2pa: candidate })) summary.c2pa = candidate;
  }
  if (full.warnings.length)
    summary.properties.technical_metadata_warning_count = full.warnings.length;
  const priority = [
    'width',
    'height',
    'duration_seconds',
    'bit_depth',
    'channels',
    'sample_rate_hz',
    'color_space',
    'has_embedded_color_profile'
  ];
  const properties = Object.entries(full.properties).sort(([a], [b]) => {
    const orderA = priority.includes(a) ? priority.indexOf(a) : priority.length;
    const orderB = priority.includes(b) ? priority.indexOf(b) : priority.length;
    return orderA - orderB || a.localeCompare(b, 'en');
  });
  for (const [key, value] of properties) {
    if (Object.prototype.hasOwnProperty.call(retained, key)) continue;
    summary.properties[key] = value;
    if (!fits(summary)) {
      delete summary.properties[key];
      summary.properties.technical_metadata_properties_omitted = true;
    }
  }
  for (const warning of full.warnings) {
    if (!fits({ ...summary, warnings: [...summary.warnings, warning] }))
      continue;
    summary.warnings.push(warning);
  }
  if (summary.warnings.length !== full.warnings.length)
    summary.properties.technical_metadata_warnings_omitted = true;
  return summary;
}

function shortText(value: string): string {
  return Buffer.byteLength(value) <= 160
    ? value
    : 'See complete technical metadata';
}

function fits(metadata: AssetTechnicalMetadata): boolean {
  return (
    Buffer.byteLength(JSON.stringify(metadata), 'utf8') <=
    LINKED_TECHNICAL_METADATA_BYTES - 128
  );
}
