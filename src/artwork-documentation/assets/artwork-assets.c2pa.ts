import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export const C2PA_VALIDATOR_VERSION = '0.9.5+6529.1';
export const C2PA_VALIDATION_SETTINGS = Object.freeze({
  version: 1,
  verify: {
    verify_after_reading: true,
    verify_trust: false,
    verify_timestamp_trust: false,
    remote_manifest_fetch: false,
    ocsp_fetch: false
  }
});
export const C2PA_FILE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'tif',
  'tiff',
  'dng',
  'webp',
  'gif',
  'avif',
  'heic',
  'heif',
  'mp4',
  'mov',
  'm4a',
  'wav',
  'mp3',
  'flac',
  'pdf',
  'svg'
]);
export type AssetC2paResult = {
  status:
    | 'not_validated'
    | 'no_manifest'
    | 'report_available'
    | 'failed'
    | 'unsupported';
  original_bytes_preserved: true;
  validator?: string;
  validator_version?: string;
  media_sha256?: string;
  report_sha256?: string;
  report?: Record<string, unknown>;
  trust?: 'not_assessed';
  remote_fetch?: false;
  error_code?: string;
  settings_sha256?: string;
  report_size_bytes?: number;
  integrity?: 'valid' | 'invalid' | 'not_determined';
};
export type AssetC2paInspection = {
  metadata: AssetC2paResult;
  reportPath?: string;
};

// Static source, with untrusted filenames passed exclusively as argv. The SDK must never sign or execute the artwork.
const READER_SCRIPT = `
import { Reader } from '@contentauth/c2pa-node';
import { writeFileSync } from 'node:fs';
const settings = JSON.parse(process.argv[3]);
try {
  const reader = await Reader.fromAsset({ path: process.argv[1], mimeType: process.argv[2] }, settings);
  if (!reader) process.stdout.write(JSON.stringify({ status: 'no_manifest' }));
  else {
    const report = reader.json();
    const serialized = JSON.stringify(report);
    writeFileSync(process.argv[4], serialized, { flag: 'wx', mode: 0o600 });
    const state = String(report.validation_state ?? '').toLowerCase();
    process.stdout.write(JSON.stringify({ status: 'report_available', integrity: ['valid', 'trusted'].includes(state) ? 'valid' : state === 'invalid' ? 'invalid' : 'not_determined', ...(Buffer.byteLength(serialized, 'utf8') <= 128 * 1024 ? { report } : {}) }));
  }
} catch (error) {
  const message = String(error?.message ?? error);
  process.stdout.write(JSON.stringify({ status: /unsupported.*(?:type|format)|unsupportedtype/i.test(message) ? 'unsupported' : 'failed', error_code: 'C2PA_VALIDATION_FAILED' }));
}
`;

/** A separate process bounds a native parser's lifetime and report size. No trust anchor or identity is inferred. */
export async function validateAssetC2pa(
  path: string,
  mime: string,
  sha256: string
): Promise<AssetC2paInspection> {
  const base = {
    original_bytes_preserved: true as const,
    validator: '@contentauth/c2pa-node',
    validator_version: C2PA_VALIDATOR_VERSION,
    media_sha256: sha256,
    trust: 'not_assessed' as const,
    remote_fetch: false as const,
    settings_sha256: createHash('sha256')
      .update(JSON.stringify(C2PA_VALIDATION_SETTINGS))
      .digest('hex')
  };
  const reportPath = join(dirname(path), 'c2pa-validation-report.json');
  const metadata = await new Promise<AssetC2paResult>((resolve) => {
    execFile(
      process.execPath,
      [
        '--max-old-space-size=256',
        '--input-type=module',
        '-e',
        READER_SCRIPT,
        path,
        mime,
        JSON.stringify(C2PA_VALIDATION_SETTINGS),
        reportPath
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 2 * 1024 ** 2,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) {
          resolve({
            ...base,
            status: 'failed',
            error_code: error.killed
              ? 'C2PA_VALIDATION_TIMEOUT'
              : 'C2PA_VALIDATOR_UNAVAILABLE'
          });
          return;
        }
        try {
          const result = JSON.parse(stdout) as Pick<
            AssetC2paResult,
            'status' | 'report' | 'error_code' | 'integrity'
          >;
          if (
            ![
              'no_manifest',
              'report_available',
              'failed',
              'unsupported'
            ].includes(result.status)
          )
            throw new Error('Invalid validator result');
          resolve({ ...base, ...result });
        } catch {
          resolve({
            ...base,
            status: 'failed',
            error_code: 'C2PA_INVALID_VALIDATOR_REPORT'
          });
        }
      }
    );
  });
  if (metadata.status !== 'report_available') return { metadata };
  const size = (await stat(reportPath)).size;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(reportPath)) digest.update(chunk);
  return {
    metadata: {
      ...metadata,
      report_sha256: digest.digest('hex'),
      report_size_bytes: size
    },
    reportPath
  };
}
