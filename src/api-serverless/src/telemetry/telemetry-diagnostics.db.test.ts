import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  deleteExpiredDiagnostics,
  fetchDiagnostics,
  insertDiagnostics,
  listDiagnostics
} from '@/api/telemetry/telemetry-diagnostics.db';
import { encryptDiagnostics } from '@/api/telemetry/telemetry-diagnostics-crypto';

function row(code: string, createdAt: string, expiresAt: string) {
  return {
    code,
    created_at: new Date(createdAt),
    expires_at: new Date(expiresAt),
    ...encryptDiagnostics(randomBytes(64), code),
    compressed_bytes: 64,
    uncompressed_bytes: 200
  };
}

describeWithSeed('telemetry diagnostics store', [], () => {
  const now = new Date('2026-11-10T00:00:00Z');

  beforeAll(() => {
    process.env.TELEMETRY_DIAG_KEY = randomBytes(32).toString('base64');
  });

  afterAll(() => {
    delete process.env.TELEMETRY_DIAG_KEY;
  });

  it('round-trips encrypted rows and hides expired ones', async () => {
    const live = row(
      'D-AAAA-0001',
      '2026-11-06T00:00:00Z',
      '2026-11-20T00:00:00Z'
    );
    const expired = row(
      'D-AAAA-0002',
      '2026-10-20T00:00:00Z',
      '2026-11-03T00:00:00Z'
    );
    expect(await insertDiagnostics(live)).toBe(true);
    expect(await insertDiagnostics(expired)).toBe(true);
    expect(await insertDiagnostics(live)).toBe(false);

    const fetched = await fetchDiagnostics(live.code, now);
    expect(Buffer.from(fetched!.ciphertext).equals(live.ciphertext)).toBe(true);
    expect(Buffer.from(fetched!.iv).equals(live.iv)).toBe(true);
    expect(Buffer.from(fetched!.auth_tag).equals(live.auth_tag)).toBe(true);
    expect(await fetchDiagnostics(expired.code, now)).toBeNull();
    expect((await listDiagnostics(now, 50)).map((r) => r.code)).toEqual([
      live.code
    ]);
  });

  it('hard-deletes bundles past their expiry', async () => {
    await insertDiagnostics(
      row('D-AAAA-0003', '2026-10-20T00:00:00Z', '2026-11-03T00:00:00Z')
    );
    await insertDiagnostics(
      row('D-AAAA-0004', '2026-11-06T00:00:00Z', '2026-11-20T00:00:00Z')
    );
    expect(await deleteExpiredDiagnostics(now)).toBe(1);
    expect(
      (await listDiagnostics(new Date('2026-01-01T00:00:00Z'), 50)).map(
        (r) => r.code
      )
    ).toEqual(['D-AAAA-0004']);
  });
});
