import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  C2PA_VALIDATION_SETTINGS,
  validateAssetC2pa
} from './artwork-assets.c2pa';

describe('actual offline C2PA validation', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'c2pa-validation-test-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function inspect(name: string) {
    const path = join(directory, 'original.jpg');
    await copyFile(join(__dirname, 'fixtures', name), path);
    const bytes = await readFile(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      path,
      bytes,
      digest,
      result: await validateAssetC2pa(path, 'image/jpeg', digest)
    };
  }
  it('reports absent credentials without inventing provenance', async () => {
    const { result } = await inspect('c2pa-unsigned.jpg');
    expect(result.metadata.status).toBe('no_manifest');
    expect(result.reportPath).toBeUndefined();
    expect(result.metadata.trust).toBe('not_assessed');
  }, 70000);
  it('retains the complete native validation report bound to the untouched signed fixture', async () => {
    const { result, path, bytes, digest } = await inspect('c2pa-signed.jpg');
    expect(result.metadata.status).toBe('report_available');
    expect(result.metadata.integrity).toBe('valid');
    expect(result.metadata.media_sha256).toBe(digest);
    expect(result.metadata.trust).toBe('not_assessed');
    expect(result.metadata.remote_fetch).toBe(false);
    const report = await readFile(result.reportPath!);
    expect(createHash('sha256').update(report).digest('hex')).toBe(
      result.metadata.report_sha256
    );
    expect(JSON.parse(report.toString('utf8')).active_manifest).toBeTruthy();
    expect(await readFile(path)).toEqual(bytes);
    expect(C2PA_VALIDATION_SETTINGS.verify).toMatchObject({
      remote_manifest_fetch: false,
      ocsp_fetch: false,
      verify_after_reading: true
    });
  }, 70000);
  it('reports altered media as invalid while retaining the original embedded claims', async () => {
    const bytes = await readFile(
      join(__dirname, 'fixtures', 'c2pa-signed.jpg')
    );
    // Alter an entropy byte near the end, leaving the JPEG framing and embedded manifest intact.
    const index = bytes.length - 100;
    expect(bytes[index]).not.toBe(0xff);
    bytes[index] ^= 1;
    const path = join(directory, 'altered.jpg');
    await writeFile(path, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const { metadata, reportPath } = await validateAssetC2pa(
      path,
      'image/jpeg',
      digest
    );
    expect(metadata).toMatchObject({
      status: 'report_available',
      integrity: 'invalid',
      trust: 'not_assessed',
      media_sha256: digest
    });
    const report = JSON.parse((await readFile(reportPath!)).toString('utf8'));
    expect(report.active_manifest).toBeTruthy();
    expect(JSON.stringify(report)).toContain('assertion.dataHash.mismatch');
    expect(await readFile(path)).toEqual(bytes);
  }, 70000);
});
