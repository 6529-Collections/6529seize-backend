import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  summarizeTechnicalMetadata,
  LINKED_TECHNICAL_METADATA_BYTES
} from './artwork-assets.manifest';
import { characterizeAssetHeader } from './artwork-assets.characterization';

describe('bounded technical metadata in linked record manifests', () => {
  it('enforces the byte limit even when base fields, credential fields and warnings are oversized', () => {
    const full = characterizeAssetHeader(
      Buffer.alloc(0),
      'mp4',
      1024,
      'a'.repeat(64)
    );
    full.method = '𐐷'.repeat(5000);
    full.detected_format = '測'.repeat(5000);
    full.warnings = Array.from(
      { length: 3000 },
      (_, index) => `Warning ${index}: ${'字'.repeat(1000)}`
    );
    full.c2pa.validator = 'x'.repeat(50000);
    full.c2pa.error_code = 'y'.repeat(50000);
    const raw = JSON.stringify(full);
    const summary = summarizeTechnicalMetadata(raw);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(
      LINKED_TECHNICAL_METADATA_BYTES
    );
    expect(summary.properties.technical_metadata_warning_count).toBe(3000);
    expect(summary.properties.technical_metadata_warnings_omitted).toBe(true);
    expect(JSON.stringify(full)).toBe(raw);
    expect(summary.properties.technical_metadata_json_sha256).toBe(
      createHash('sha256').update(raw).digest('hex')
    );
  });
  it('permits runtime report sidecars and expires obsolete versions without expiring current evidence', () => {
    const template = parse(
      readFileSync(
        join(__dirname, '../../artworkDocumentationStorage/serverless.yaml'),
        'utf8'
      ),
      {
        customTags: ['!Sub', '!Ref', '!GetAtt'].map((tag) => ({
          tag,
          resolve: (value: string) => value
        }))
      }
    );
    const policy =
      template.resources.Resources.ArtworkArchiveBucketPolicy.Properties.PolicyDocument.Statement.find(
        (statement: { Sid: string }) =>
          statement.Sid === 'ArchiveRuntimeObjectOperations'
      );
    expect(policy.Resource).toContain(
      '${ArtworkArchiveBucket.Arn}/validation-reports/*'
    );
    expect(policy.Action).toEqual(
      expect.arrayContaining([
        's3:PutObject',
        's3:GetObject',
        's3:DeleteObject'
      ])
    );
    const lifecycle =
      template.resources.Resources.ArtworkArchiveBucket.Properties.LifecycleConfiguration.Rules.find(
        (rule: { Prefix?: string }) => rule.Prefix === 'validation-reports/'
      );
    expect(lifecycle).toMatchObject({
      Status: 'Enabled',
      NoncurrentVersionExpiration: { NoncurrentDays: 7 }
    });
    expect(lifecycle.ExpirationInDays).toBeUndefined();
  });
  it('retains fixity and archive/credential summaries without copying large source reports or inventories', () => {
    const full = characterizeAssetHeader(
      Buffer.alloc(0),
      'zip',
      1024,
      'a'.repeat(64)
    );
    full.archive = {
      entries: 2000,
      expanded_bytes: 1024 * 2000,
      inventory: Array.from({ length: 2000 }, (_, index) => ({
        path: `project/${index}/${'p'.repeat(300)}.bin`,
        size_bytes: 1024,
        sha256: 'b'.repeat(64)
      }))
    };
    full.c2pa = {
      status: 'report_available',
      original_bytes_preserved: true,
      integrity: 'valid',
      trust: 'not_assessed',
      report_sha256: 'c'.repeat(64),
      report_size_bytes: 128000,
      report: { claim: 'x'.repeat(128000) }
    };
    const raw = JSON.stringify(full);
    const summary = summarizeTechnicalMetadata(raw);
    expect(summary.archive).toBeUndefined();
    expect(summary.c2pa.report).toBeUndefined();
    expect(summary.c2pa).toMatchObject({
      integrity: 'valid',
      trust: 'not_assessed',
      report_sha256: 'c'.repeat(64),
      report_size_bytes: 128000
    });
    expect(summary.properties).toMatchObject({
      archive_entries: 2000,
      archive_expanded_bytes: 2048000,
      technical_metadata_json_sha256: createHash('sha256')
        .update(raw)
        .digest('hex'),
      archive_inventory_sha256: createHash('sha256')
        .update(JSON.stringify(full.archive.inventory))
        .digest('hex')
    });
    expect(JSON.stringify(full)).toBe(raw);
    expect(
      Buffer.byteLength(
        JSON.stringify(Array.from({ length: 1000 }, () => summary))
      )
    ).toBeLessThan(4 * 1024 ** 2);
  });
  it('bounds many AV tracks while retaining primary measurements and a digest of complete metadata', () => {
    const full = characterizeAssetHeader(
      Buffer.alloc(0),
      'mp4',
      1024,
      'a'.repeat(64)
    );
    for (let index = 0; index < 8000; index++)
      full.properties[`track_${index}_codec`] = 'x'.repeat(200);
    Object.assign(full.properties, {
      width: 14204,
      height: 9472,
      bit_depth: 16
    });
    const result = summarizeTechnicalMetadata(JSON.stringify(full));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      LINKED_TECHNICAL_METADATA_BYTES
    );
    expect(result.properties).toMatchObject({
      width: 14204,
      height: 9472,
      bit_depth: 16,
      technical_metadata_properties_omitted: true
    });
    expect(Object.keys(full.properties)).toHaveLength(8003);
  });
});
