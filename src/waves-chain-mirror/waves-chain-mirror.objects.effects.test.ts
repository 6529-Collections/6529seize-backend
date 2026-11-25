import { chainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import {
  decisionCreatedAt,
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
  afterEach(() => jest.restoreAllMocks());

  it("reads the chain's rights at the client's pin, isManager", async () => {
    const read = jest.spyOn(chainGatewayClient, 'read').mockResolvedValue({
      data: { waveId: WAVE, principalId: PRINCIPAL, isManager: true }
    } as never);
    expect(await waveManagerOf(WAVE, PRINCIPAL)).toBe(true);
    // One read, unpinned: the client pins it (the head live, a recording's
    // mark in a rebuild), as the mirror's other gateway reads.
    expect(read.mock.calls).toEqual([
      [`/v1/waves/${WAVE}/rights/${PRINCIPAL}`]
    ]);
    read.mockResolvedValue({ data: { isManager: false } } as never);
    expect(await waveManagerOf(WAVE, PRINCIPAL)).toBe(false);
  });

  it("is false for the node's not_found, and null when the gateway can't say", async () => {
    const read = jest.spyOn(chainGatewayClient, 'read');
    // No such wave or principal on the node.
    read.mockResolvedValue(null);
    expect(await waveManagerOf(WAVE, PRINCIPAL)).toBe(false);
    // An answer without isManager.
    read.mockResolvedValue({ data: { canRead: true } } as never);
    expect(await waveManagerOf(WAVE, PRINCIPAL)).toBeNull();
    // A failed read (503 unavailable, a height gone, any error).
    read.mockRejectedValue(new Error('unavailable'));
    expect(await waveManagerOf(WAVE, PRINCIPAL)).toBeNull();
  });
});
