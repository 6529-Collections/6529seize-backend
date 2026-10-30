import { refreshEns } from '@/ens';
import { fetchEnsRefresh, persistENS } from '@/db';
import { findEnsForRefresh } from '@/refreshEnsLoop/ens-refresh-lookup';
import { env } from '@/env';
import { ENS } from '@/entities/IENS';

jest.mock('@/db', () => ({
  fetchEnsRefresh: jest.fn(),
  persistENS: jest.fn()
}));
jest.mock('@/refreshEnsLoop/ens-refresh-lookup', () => ({
  findEnsForRefresh: jest.fn()
}));
jest.mock('@/env', () => ({ env: { getIntOrNull: jest.fn() } }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn(), warn: jest.fn() }) }
}));

const wallet = (id: number): ENS => ({
  wallet: `0x${String(id).padStart(40, '0')}`,
  display: `cached-${id}.eth`,
  created_at: new Date('2026-01-01')
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(fetchEnsRefresh).mockResolvedValue([]);
  jest.mocked(persistENS).mockResolvedValue(undefined);
  jest.mocked(findEnsForRefresh).mockResolvedValue({ status: 'unavailable' });
});

it('preserves failed wallets, excludes them from later batches, and advances healthy wallets', async () => {
  jest
    .mocked(fetchEnsRefresh)
    .mockResolvedValueOnce([wallet(1), wallet(2)])
    .mockResolvedValueOnce([wallet(3)]);
  jest
    .mocked(findEnsForRefresh)
    .mockResolvedValueOnce({ status: 'unavailable' })
    .mockResolvedValueOnce({ status: 'resolved', name: 'updated.eth' })
    .mockResolvedValueOnce({ status: 'resolved', name: null });
  await refreshEns(() => 900_000);
  expect(fetchEnsRefresh).toHaveBeenNthCalledWith(1, []);
  expect(fetchEnsRefresh).toHaveBeenNthCalledWith(2, [wallet(1).wallet]);
  const saved = jest.mocked(persistENS).mock.calls.flatMap(([rows]) => rows);
  expect(saved.map(({ wallet, display }) => ({ wallet, display }))).toEqual([
    { wallet: wallet(2).wallet, display: 'updated.eth' },
    { wallet: wallet(3).wallet, display: null }
  ]);
});

it('retries failed wallets in the next invocation without marking them refreshed', async () => {
  jest.mocked(fetchEnsRefresh).mockResolvedValueOnce([wallet(1)]);
  await refreshEns(() => 900_000);
  expect(persistENS).not.toHaveBeenCalled();
  jest.mocked(fetchEnsRefresh).mockClear();
  await refreshEns(() => 900_000);
  expect(fetchEnsRefresh).toHaveBeenCalledWith([]);
});

it('caps each lookup at ten seconds', async () => {
  jest.mocked(fetchEnsRefresh).mockResolvedValueOnce([wallet(1)]);
  await refreshEns(() => 900_000);
  expect(findEnsForRefresh).toHaveBeenCalledWith(wallet(1).wallet, 10_000);
});

it('caps failed-wallet exclusions during an extended provider outage', async () => {
  let batch = 0;
  jest.mocked(fetchEnsRefresh).mockImplementation(async () => {
    const start = batch++ * 100;
    return Array.from({ length: 100 }, (_, i) => wallet(start + i));
  });
  await refreshEns(() => 900_000);
  expect(findEnsForRefresh).toHaveBeenCalledTimes(500);
  expect(fetchEnsRefresh).toHaveBeenCalledTimes(5);
  expect(jest.mocked(fetchEnsRefresh).mock.calls[4][0]).toHaveLength(400);
  expect(persistENS).not.toHaveBeenCalled();
});

it('shortens the last lookup and saves completed work before the shutdown reserve', async () => {
  let remaining = 65_000;
  jest.mocked(fetchEnsRefresh).mockResolvedValueOnce([wallet(1), wallet(2)]);
  jest.mocked(findEnsForRefresh).mockImplementation(async () => {
    remaining = 60_000;
    return { status: 'resolved', name: 'updated.eth' };
  });
  await refreshEns(() => remaining);
  expect(findEnsForRefresh).toHaveBeenCalledTimes(1);
  expect(findEnsForRefresh).toHaveBeenCalledWith(
    wallet(1).wallet,
    expect.any(Number)
  );
  expect(jest.mocked(findEnsForRefresh).mock.calls[0][1]).toBeLessThanOrEqual(
    5000
  );
  expect(persistENS).toHaveBeenCalledWith([
    expect.objectContaining({ display: 'updated.eth' })
  ]);
});

it('does not reduce the one-minute shutdown reserve through configuration', async () => {
  jest.mocked(env.getIntOrNull).mockReturnValue(0);
  await refreshEns(() => 59_000);
  expect(fetchEnsRefresh).not.toHaveBeenCalled();
  expect(findEnsForRefresh).not.toHaveBeenCalled();
});

it('does not mark a wallet unavailable when too little lookup budget remains', async () => {
  let remaining = 65_000;
  jest.mocked(fetchEnsRefresh).mockImplementationOnce(async () => {
    remaining = 60_500;
    return [wallet(1)];
  });
  await refreshEns(() => remaining);
  expect(findEnsForRefresh).not.toHaveBeenCalled();
  expect(persistENS).not.toHaveBeenCalled();
});
