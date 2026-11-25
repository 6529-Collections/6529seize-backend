import { chainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { decisionCreatedAt } from './waves-chain-mirror.objects.effects';

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
