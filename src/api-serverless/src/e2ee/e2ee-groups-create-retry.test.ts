import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import { ApiE2eeCreateGroupRequest } from '@/api/generated/models/ApiE2eeCreateGroupRequest';
import { E2eeDb } from '@/e2ee/e2ee.db';

const PROFILE = 'profile-1';
const request: ApiE2eeCreateGroupRequest = {
  group: `0x${'11'.repeat(32)}`,
  commit_key: `0x${'33'.repeat(32)}`,
  creator_device_key: `0x${'22'.repeat(32)}`
};

function serviceWith(transaction: jest.Mock): E2eeGroupsService {
  const db = {
    getDevice: jest.fn().mockResolvedValue({
      profile_id: PROFILE,
      revoked_at: null,
      expires_at_seconds: Number.MAX_SAFE_INTEGER
    }),
    hitRateCounters: jest.fn(
      async (rows: { key: string }[]) =>
        new Map(rows.map((row) => [row.key, 1]))
    ),
    executeNativeQueriesInTransaction: transaction,
    getGroup: jest.fn().mockResolvedValue({ epoch: 4 })
  } as unknown as E2eeDb;
  const deps = {
    db,
    now: () => 1_760_000_000_000
  } as unknown as E2eeServiceDeps;
  return new E2eeGroupsService(deps);
}

describe('E2eeGroupsService.createGroup transaction retries', () => {
  it('retries a creation that lost an InnoDB deadlock', async () => {
    const created = { group: request.group };
    const transaction = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ER_LOCK_DEADLOCK' })
      .mockResolvedValueOnce(created);

    await expect(
      serviceWith(transaction).createGroup(PROFILE, request)
    ).resolves.toBe(created);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up after three deadlocks', async () => {
    const deadlock = { code: 'ER_LOCK_DEADLOCK' };
    const transaction = jest.fn().mockRejectedValue(deadlock);

    await expect(
      serviceWith(transaction).createGroup(PROFILE, request)
    ).rejects.toBe(deadlock);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('maps a duplicate handle to an epoch conflict without retrying', async () => {
    const transaction = jest.fn().mockRejectedValue({ code: 'ER_DUP_ENTRY' });

    await expect(
      serviceWith(transaction).createGroup(PROFILE, request)
    ).rejects.toMatchObject({ code: 'E2EE_EPOCH_CONFLICT' });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('E2eeGroupsService.ackWelcome deadlock retries', () => {
  const device = request.creator_device_key;
  const welcome = `0x${'44'.repeat(16)}`;

  it('retries an acknowledgement that lost a deadlock to a sibling device', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ER_LOCK_DEADLOCK' })
      .mockResolvedValueOnce(undefined);

    await expect(
      serviceWith(transaction).ackWelcome(PROFILE, device, welcome)
    ).resolves.toEqual({});
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up after three deadlocks and does not retry other errors', async () => {
    const deadlock = { code: 'ER_LOCK_DEADLOCK' };
    const always = jest.fn().mockRejectedValue(deadlock);
    await expect(
      serviceWith(always).ackWelcome(PROFILE, device, welcome)
    ).rejects.toBe(deadlock);
    expect(always).toHaveBeenCalledTimes(3);

    const other = new Error('connection lost');
    const once = jest.fn().mockRejectedValue(other);
    await expect(
      serviceWith(once).ackWelcome(PROFILE, device, welcome)
    ).rejects.toBe(other);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
