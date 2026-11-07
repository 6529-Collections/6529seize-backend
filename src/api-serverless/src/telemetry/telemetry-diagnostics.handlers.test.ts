import {
  handleGetTelemetryDiagnosticsBundle,
  handleListTelemetryDiagnostics
} from '@/api/telemetry/telemetry-diagnostics.handlers';
import { ForbiddenException, NotFoundException } from '@/exceptions';

const mockReadDiagnostics = jest.fn();
const mockListDiagnostics = jest.fn();
const mockAssertReader = jest.fn();
const mockLogLines: string[] = [];

jest.mock('@/logging', () => ({
  Logger: {
    get: () => {
      const record = (...args: unknown[]) =>
        mockLogLines.push(args.map((a) => String(a)).join(' '));
      return { info: record, warn: record, error: record, debug: record };
    }
  }
}));

jest.mock('@/api/telemetry/telemetry-diagnostics', () => ({
  readDiagnostics: (...args: unknown[]) => mockReadDiagnostics(...args)
}));

jest.mock('@/api/telemetry/telemetry-diagnostics.db', () => ({
  listDiagnostics: (...args: unknown[]) => mockListDiagnostics(...args)
}));

jest.mock('@/api/telemetry/telemetry-team-auth', () => ({
  assertTelemetryTeamReader: (...args: unknown[]) => mockAssertReader(...args)
}));

const READER = 'profile-reader';

function request(extra: Record<string, unknown> = {}) {
  return {
    query: {},
    params: {},
    res: { setHeader: jest.fn() },
    ...extra
  } as any;
}

describe('team-only diagnostics reads', () => {
  beforeEach(() => {
    mockReadDiagnostics.mockReset();
    mockListDiagnostics.mockReset();
    mockAssertReader.mockReset().mockResolvedValue(READER);
    mockLogLines.length = 0;
  });

  it('refuses callers the reader check rejects, before touching any bundle', async () => {
    mockAssertReader.mockRejectedValue(new ForbiddenException('no'));
    await expect(
      handleGetTelemetryDiagnosticsBundle(
        request({ params: { code: 'D-7K3Q-9XW2' } })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      handleListTelemetryDiagnostics(request())
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockReadDiagnostics).not.toHaveBeenCalled();
    expect(mockListDiagnostics).not.toHaveBeenCalled();
  });

  it('returns a bundle to a reader and audits only profile id and code', async () => {
    mockReadDiagnostics.mockResolvedValue({
      code: 'D-7K3Q-9XW2',
      created_at: new Date('2026-11-06T10:00:00Z'),
      expires_at: new Date('2026-11-20T10:00:00Z'),
      compressed_bytes: 100,
      uncompressed_bytes: 400,
      bundle: { v: 1, secretish: 'bundle-content-probe' }
    });
    const req = request({ params: { code: 'd-7k3q-9xw2' } });
    const result = await handleGetTelemetryDiagnosticsBundle(req);
    expect(mockReadDiagnostics).toHaveBeenCalledWith(
      'D-7K3Q-9XW2',
      expect.any(Date)
    );
    expect(result).toEqual({
      code: 'D-7K3Q-9XW2',
      created_at: new Date('2026-11-06T10:00:00.000Z'),
      expires_at: new Date('2026-11-20T10:00:00.000Z'),
      compressed_bytes: 100,
      uncompressed_bytes: 400,
      bundle: { v: 1, secretish: 'bundle-content-probe' }
    });
    expect(req.res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store'
    );
    expect(mockLogLines).toEqual([
      'Diagnostics bundle read: code=D-7K3Q-9XW2 reader_profile_id=profile-reader'
    ]);
  });

  it('answers 404 for unknown, malformed or expired codes', async () => {
    mockReadDiagnostics.mockResolvedValue(null);
    await expect(
      handleGetTelemetryDiagnosticsBundle(
        request({ params: { code: 'D-0000-0000' } })
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      handleGetTelemetryDiagnosticsBundle(request({ params: { code: 'nope' } }))
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mockLogLines).toEqual([]);
  });

  it('lists unexpired bundles for a reader', async () => {
    mockListDiagnostics.mockResolvedValue([
      {
        code: 'D-7K3Q-9XW2',
        created_at: new Date('2026-11-06T10:00:00Z'),
        expires_at: new Date('2026-11-20T10:00:00Z'),
        compressed_bytes: '100',
        uncompressed_bytes: '400'
      }
    ]);
    const result = await handleListTelemetryDiagnostics(
      request({ query: { limit: '10' } })
    );
    expect(mockListDiagnostics).toHaveBeenCalledWith(expect.any(Date), 10);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].compressed_bytes).toBe(100);
  });
});
