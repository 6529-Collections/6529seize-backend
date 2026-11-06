import {
  handleGetTelemetryDiagnosticsBundle,
  handleListTelemetryDiagnostics
} from '@/api/telemetry/telemetry-diagnostics.handlers';
import { ForbiddenException, NotFoundException } from '@/exceptions';

const mockReadDiagnostics = jest.fn();
const mockListDiagnostics = jest.fn();

jest.mock('@/api/telemetry/telemetry-diagnostics', () => ({
  readDiagnostics: (...args: unknown[]) => mockReadDiagnostics(...args)
}));

jest.mock('@/api/telemetry/telemetry-diagnostics.db', () => ({
  listDiagnostics: (...args: unknown[]) => mockListDiagnostics(...args)
}));

const TEAM_WALLET = '0x00000000000000000000000000000000000000aa';
const OTHER_WALLET = '0x00000000000000000000000000000000000000bb';

function request(wallet: string | null, extra: Record<string, unknown> = {}) {
  return {
    user: wallet ? { wallet } : undefined,
    query: {},
    params: {},
    res: { setHeader: jest.fn() },
    ...extra
  } as any;
}

describe('team-only diagnostics reads', () => {
  beforeEach(() => {
    process.env.TELEMETRY_TEAM_WALLETS = `${TEAM_WALLET.toUpperCase().replace('0X', '0x')}, 0x1`;
    mockReadDiagnostics.mockReset();
    mockListDiagnostics.mockReset();
  });

  afterAll(() => {
    delete process.env.TELEMETRY_TEAM_WALLETS;
  });

  it('refuses wallets outside the team list', async () => {
    await expect(
      handleGetTelemetryDiagnosticsBundle(
        request(OTHER_WALLET, { params: { code: 'D-7K3Q-9XW2' } })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      handleListTelemetryDiagnostics(request(null))
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockReadDiagnostics).not.toHaveBeenCalled();
    expect(mockListDiagnostics).not.toHaveBeenCalled();
  });

  it('refuses everyone when no team list is configured', async () => {
    delete process.env.TELEMETRY_TEAM_WALLETS;
    await expect(
      handleListTelemetryDiagnostics(request(TEAM_WALLET))
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns a bundle to a team wallet with private cache headers', async () => {
    mockReadDiagnostics.mockResolvedValue({
      code: 'D-7K3Q-9XW2',
      created_at: new Date('2026-11-06T10:00:00Z'),
      expires_at: new Date('2026-11-20T10:00:00Z'),
      compressed_bytes: 100,
      uncompressed_bytes: 400,
      bundle: { v: 1 }
    });
    const req = request(TEAM_WALLET, { params: { code: 'd-7k3q-9xw2' } });
    const result = await handleGetTelemetryDiagnosticsBundle(req);
    expect(mockReadDiagnostics).toHaveBeenCalledWith(
      'D-7K3Q-9XW2',
      expect.any(Date)
    );
    expect(result).toEqual({
      code: 'D-7K3Q-9XW2',
      created_at: '2026-11-06T10:00:00.000Z',
      expires_at: '2026-11-20T10:00:00.000Z',
      compressed_bytes: 100,
      uncompressed_bytes: 400,
      bundle: { v: 1 }
    });
    expect(req.res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store'
    );
  });

  it('answers 404 for unknown, malformed or expired codes', async () => {
    mockReadDiagnostics.mockResolvedValue(null);
    await expect(
      handleGetTelemetryDiagnosticsBundle(
        request(TEAM_WALLET, { params: { code: 'D-0000-0000' } })
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      handleGetTelemetryDiagnosticsBundle(
        request(TEAM_WALLET, { params: { code: 'nope' } })
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists unexpired bundles for the team', async () => {
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
      request(TEAM_WALLET, { query: { limit: '10' } })
    );
    expect(mockListDiagnostics).toHaveBeenCalledWith(expect.any(Date), 10);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].compressed_bytes).toBe(100);
  });
});
