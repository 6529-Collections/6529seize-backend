import { userGroupsService } from '@/api/community-members/user-groups.service';
import { chainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { userGroupsDb } from '@/user-groups/user-groups.db';
import {
  decisionCreatedAt,
  defaultObjectEffects,
  waveManagerOf
} from './waves-chain-mirror.objects.effects';

const D = `0x${'d1'.repeat(32)}`;

describe('decisionCreatedAt', () => {
  afterEach(() => jest.restoreAllMocks());

  it("reads the block of the decision's first policy version, and its time", async () => {
    const read = jest
      .spyOn(chainGatewayClient, 'read')
      .mockImplementation(async (path: string) =>
        path.endsWith('/policies')
          ? ({
              data: [
                { version: 2, activationHeight: 90 },
                { version: 1, activationHeight: '41' }
              ]
            } as never)
          : path === '/v1/blocks/41'
            ? ({ data: { time: 1_764_041_000 } } as never)
            : null
      );
    expect(await decisionCreatedAt(D)).toBe(1_764_041_000);
    expect(read.mock.calls.map((call) => call[0])).toEqual([
      `/v1/decisions/${D}/policies`,
      '/v1/blocks/41'
    ]);
  });

  it("is null when the gateway can't say", async () => {
    jest.spyOn(chainGatewayClient, 'read').mockResolvedValue(null);
    expect(await decisionCreatedAt(D)).toBeNull();
    jest
      .spyOn(chainGatewayClient, 'read')
      .mockRejectedValue(new Error('CHAIN_GATEWAY_URL is not set'));
    expect(await decisionCreatedAt(D)).toBeNull();
    jest
      .spyOn(chainGatewayClient, 'read')
      .mockResolvedValue({ data: { policies: [{ version: 1 }] } } as never);
    expect(await decisionCreatedAt(D)).toBeNull();
  });
});

describe('waveManagerOf', () => {
  const WAVE = `0x${'0e'.repeat(32)}`;
  const PRINCIPAL = `0x${'11'.repeat(32)}`;
  const PATH = `/v1/waves/${WAVE}/rights/${PRINCIPAL}`;
  afterEach(() => jest.restoreAllMocks());

  it("reads the chain's rights at the index's height, isManager", async () => {
    const read = jest.spyOn(chainGatewayClient, 'read').mockResolvedValue({
      data: { waveId: WAVE, principalId: PRINCIPAL, isManager: true }
    } as never);
    expect(await waveManagerOf(WAVE, PRINCIPAL, 4_200)).toBe(true);
    read.mockResolvedValue({ data: { isManager: false } } as never);
    expect(await waveManagerOf(WAVE, PRINCIPAL, 4_200)).toBe(false);
    // Without a height: the client's pin.
    expect(await waveManagerOf(WAVE, PRINCIPAL)).toBe(false);
    expect(read.mock.calls).toEqual([
      [PATH, {}, { height: 4_200 }],
      [PATH, {}, { height: 4_200 }],
      [PATH, {}, {}]
    ]);
  });

  it("is null when the gateway can't say, its not_found included", async () => {
    const read = jest.spyOn(chainGatewayClient, 'read');
    // The node's not_found: a read behind the index, never a "no" (a
    // parent left out would be for good).
    read.mockResolvedValue(null);
    expect(await waveManagerOf(WAVE, PRINCIPAL, 4_200)).toBeNull();
    // An answer without isManager.
    read.mockResolvedValue({ data: { canRead: true } } as never);
    expect(await waveManagerOf(WAVE, PRINCIPAL, 4_200)).toBeNull();
    // A failed read (503 unavailable, a height gone, any error).
    read.mockRejectedValue(new Error('unavailable'));
    expect(await waveManagerOf(WAVE, PRINCIPAL, 4_200)).toBeNull();
  });
});

describe('defaultObjectEffects.groupsChanged', () => {
  afterEach(() => jest.restoreAllMocks());

  it("clears the groups' caches only once each profile's change is logged", async () => {
    let logged!: () => void;
    const log = jest
      .spyOn(userGroupsDb, 'insertGroupChanges')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            logged = () => resolve(null);
          })
      );
    const clear = jest
      .spyOn(userGroupsService, 'onWaveRelatedGroupsChanged')
      .mockResolvedValue(undefined);
    const changed = defaultObjectEffects.groupsChanged(['g'], ['p1', 'p2']);
    // Let everything not waiting on the log run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith(['p1', 'p2']);
    expect(clear).not.toHaveBeenCalled();
    logged();
    await changed;
    expect(clear).toHaveBeenCalledWith(['g'], {});
  });

  it("clears the groups' caches with no change to log when no profile is given", async () => {
    const log = jest
      .spyOn(userGroupsDb, 'insertGroupChanges')
      .mockResolvedValue(null);
    const clear = jest
      .spyOn(userGroupsService, 'onWaveRelatedGroupsChanged')
      .mockResolvedValue(undefined);
    await defaultObjectEffects.groupsChanged(['g'], []);
    expect(log).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(['g'], {});
  });
});
