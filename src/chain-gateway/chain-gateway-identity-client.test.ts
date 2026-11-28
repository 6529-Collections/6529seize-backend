import {
  ChainGatewayClient,
  chainGatewayConfigFromEnv,
  chainGatewayHeadTtlMs,
  identityReadsGatewayConfigFromEnv
} from './chain-gateway.client';

const ENV = {
  CHAIN_GATEWAY_URL: 'https://gateway.test/',
  CHAIN_GATEWAY_SERVICE_KEY: 'service-key',
  CHAIN_GATEWAY_TIMEOUT_MS: '9000',
  CHAIN_GATEWAY_RETRIES: '4',
  CHAIN_GATEWAY_HEAD_TTL_MS: '5000',
  CHAIN_GATEWAY_CACHE_ENTRIES: '77'
};

describe("the identity lookups' gateway client", () => {
  it('takes retries 1 and a 3,000 ms timeout, the rest as the environment says', () => {
    expect(identityReadsGatewayConfigFromEnv(ENV)).toEqual({
      baseUrl: 'https://gateway.test',
      serviceKey: 'service-key',
      timeoutMs: 3_000,
      retries: 1,
      headTtlMs: 5_000,
      cacheEntries: 77
    });
    // The process-wide client keeps its own.
    expect(chainGatewayConfigFromEnv(ENV)).toMatchObject({
      timeoutMs: 9_000,
      retries: 4
    });
  });

  it('reads its own two settings', () => {
    expect(
      identityReadsGatewayConfigFromEnv({
        ...ENV,
        CHAIN_GATEWAY_IDENTITY_RETRIES: '0',
        CHAIN_GATEWAY_IDENTITY_TIMEOUT_MS: '1500'
      })
    ).toMatchObject({ retries: 0, timeoutMs: 1_500 });
    // A timeout of 0 would abort every request: the default instead.
    expect(
      identityReadsGatewayConfigFromEnv({
        ...ENV,
        CHAIN_GATEWAY_IDENTITY_TIMEOUT_MS: '0',
        CHAIN_GATEWAY_IDENTITY_RETRIES: 'x'
      })
    ).toMatchObject({ retries: 1, timeoutMs: 3_000 });
    // Unset URL: refused as for the process-wide client.
    expect(() => identityReadsGatewayConfigFromEnv({})).toThrow(
      'CHAIN_GATEWAY_URL is not set'
    );
  });

  it('reads the head time without the rest of the settings', () => {
    expect(chainGatewayHeadTtlMs({})).toBe(2_000);
    expect(chainGatewayHeadTtlMs({ CHAIN_GATEWAY_HEAD_TTL_MS: '15000' })).toBe(
      15_000
    );
  });

  it('says the network of the last head it read, reading none to say it', async () => {
    const network = '0x' + '22'.repeat(32);
    const stamp = (height: number) => ({
      at: 'finalized',
      height,
      root: '0x' + '11'.repeat(32),
      slot: height + 10,
      time: 1_764_000_000_000 + height,
      finalizedHeight: height,
      headHeight: height + 3,
      network
    });
    const fetchImpl = jest.fn(async () => {
      const text = JSON.stringify({
        read: stamp(100),
        data: {
          ready: true,
          head: stamp(103),
          finalized: stamp(100)
        },
        next: null
      });
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => {
          const bytes = Buffer.from(text);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer;
        }
      };
    });
    const client = new ChainGatewayClient(() => ({
      ...identityReadsGatewayConfigFromEnv(ENV),
      fetchImpl,
      now: () => 1_000
    }));
    expect(client.lastSeenNetwork()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.getHead();
    expect(client.lastSeenNetwork()).toBe(network);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
