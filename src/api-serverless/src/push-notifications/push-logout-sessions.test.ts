import { revokeNativeSessions } from './push-logout-sessions';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { execute: jest.fn().mockResolvedValue([]) }
}));
jest.mock('@/api/auth/auth-session-v2', () => ({
  hashSecret: (value: string) => `hash-${value}`
}));

it('acquires overlapping session locks in the same order regardless of request order', async () => {
  const sessions = [
    { address: '0xABC', native_refresh_token: 'z' },
    { address: '0xDEF', native_refresh_token: 'a' }
  ];
  const execute = jest.mocked(sqlExecutor.execute);
  await revokeNativeSessions(sessions, {});
  const firstOrder = execute.mock.calls.map(([, params]) => ({
    address: params?.address,
    hash: params?.hash
  }));
  execute.mockClear();
  await revokeNativeSessions([...sessions].reverse(), {});
  expect(
    execute.mock.calls.map(([, params]) => ({
      address: params?.address,
      hash: params?.hash
    }))
  ).toEqual(firstOrder);
  expect(firstOrder).toEqual([
    { address: '0xdef', hash: 'hash-a' },
    { address: '0xabc', hash: 'hash-z' }
  ]);
  for (const [query] of execute.mock.calls) {
    expect(query).toContain('refresh_token_hash = :hash');
    expect(query).toContain("client_type = 'native'");
  }
});
