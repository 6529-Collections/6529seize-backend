import { handleGetSignedRecordsOwners } from '@/api/signed-records/signed-records.handlers';
import { ChainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import { recordAnchorService } from './record-anchor';
import {
  SignedRecordsGatewayReads,
  signedRecordsChainOf,
  wireSignedRecordsChain,
  wireSignedRecordsChainAtStartup
} from './record-chain';
import { recordOwnerDirectory } from './record-owner-directory';

const WALLET = `0x${'a'.repeat(40)}`;
const PRINCIPAL = `0x${'0'.repeat(63)}1`;
// RFC 5737 documentation addresses.
const GATEWAY = 'http://192.0.2.10';
const FINALIZED_AT = 1_795_000_000_000;
const NETWORK = `0x${'22'.repeat(32)}`;

/** The client's reads, as a stub; getHead answers `heads` in turn. */
function gateway(
  ...heads: Record<string, unknown>[]
): SignedRecordsGatewayReads {
  let next = 0;
  return {
    getHead: async () =>
      ({
        network: NETWORK,
        ...heads[Math.min(next++, heads.length - 1)]
      }) as never,
    getMembershipWalletHistory: async (wallet: string) =>
      (wallet === WALLET
        ? {
            wallet,
            changes: [{ height: 5, principalId: PRINCIPAL }],
            ranges: [[1, 100]],
            readHeight: 100
          }
        : null) as never,
    getIdentityByWallet: async () => null,
    getIdentityByPrincipal: async () => null,
    getIdentitiesByWallets: async () => ({})
  };
}

const owners = () =>
  handleGetSignedRecordsOwners({ query: { wallets: WALLET } } as Parameters<
    typeof handleGetSignedRecordsOwners
  >[0]);

const anchors = async (times: number) => {
  const served: number[] = [];
  for (let i = 0; i < times; i++) {
    served.push((await recordAnchorService.getAnchor()).anchor);
  }
  return served;
};

describe('wireSignedRecordsChain', () => {
  afterEach(() => {
    wireSignedRecordsChain(null);
  });

  it('wires the anchor height and the owners from one client, and unwires both', async () => {
    const client = {
      getHead: async () => ({
        headHeight: 12,
        finalizedHeight: 10,
        finalizedTime: 1_795_000_000_000
      }),
      getMembershipWalletHistory: async () => null,
      getIdentityByWallet: async () => null,
      getIdentityByPrincipal: async () => null
    };
    wireSignedRecordsChain(client);
    expect(recordOwnerDirectory.hasChain()).toBe(true);
    await expect(recordAnchorService.getAnchor()).resolves.toMatchObject({
      anchor: 10
    });
    wireSignedRecordsChain(null);
    expect(recordOwnerDirectory.hasChain()).toBe(false);
    await expect(recordAnchorService.getAnchor()).rejects.toThrow(
      'not configured'
    );
  });
});

describe('wireSignedRecordsChainAtStartup', () => {
  const warn = jest.spyOn(Logger.get('SIGNED_RECORDS_CHAIN'), 'warn');
  const info = jest.spyOn(Logger.get('SIGNED_RECORDS_CHAIN'), 'info');

  beforeEach(() => {
    warn.mockClear();
    info.mockClear();
  });

  afterEach(() => {
    wireSignedRecordsChain(null);
  });

  afterAll(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  it('wires the client when the gateway is configured: anchors and owners from the chain', async () => {
    const client = gateway({
      headHeight: 102,
      finalizedHeight: 100,
      finalizedTime: FINALIZED_AT
    });
    expect(
      wireSignedRecordsChainAtStartup({ CHAIN_GATEWAY_URL: GATEWAY }, client)
    ).toBe(true);
    await expect(recordAnchorService.getAnchor()).resolves.toEqual({
      anchor: 100,
      headHeight: 102,
      finalizedTime: FINALIZED_AT,
      maxAnchorLag: 120
    });
    await expect(recordOwnerDirectory.principalAt(WALLET, 50)).resolves.toBe(
      PRINCIPAL
    );
  });

  it.each([
    ['no URL', {}],
    ['a URL that is not http(s)', { CHAIN_GATEWAY_URL: 'ftp://192.0.2.10' }],
    [
      'a URL with credentials',
      { CHAIN_GATEWAY_URL: 'http://user:secret@192.0.2.10' }
    ],
    [
      'a service key that is not plain visible ASCII',
      { CHAIN_GATEWAY_URL: GATEWAY, CHAIN_GATEWAY_SERVICE_KEY: 'kéy-1' }
    ]
  ])(
    'leaves it unwired with %s: the anchor and owners routes answer their 503s',
    async (_what, env: Record<string, string>) => {
      // Wired before, as after an earlier start with another setting; the
      // last line logged is then the wired one, whatever ran before.
      wireSignedRecordsChainAtStartup(
        { CHAIN_GATEWAY_URL: GATEWAY },
        gateway({})
      );
      warn.mockClear();
      expect(wireSignedRecordsChainAtStartup(env, gateway({}))).toBe(false);
      expect(recordOwnerDirectory.hasChain()).toBe(false);
      await expect(recordAnchorService.getAnchor()).rejects.toMatchObject({
        message:
          'The chain gateway is not configured, so there is no anchor height',
        code: 'ANCHOR_UNAVAILABLE'
      });
      await expect(owners()).rejects.toMatchObject({
        message:
          'The chain gateway is not configured, so wallets have no owners yet',
        code: 'OWNERS_UNAVAILABLE'
      });
      // One line says why, never the setting's value.
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      for (const line of lines) {
        expect(line).toContain('[NOT WIRED]');
        for (const value of Object.values(env)) {
          expect(line).not.toContain(value);
        }
        expect(line).not.toMatch(/user|secret|192\.0\.2\.10|kéy/);
      }
    }
  );

  it('logs the outcome once while it stays the same, as a warm container calls it again', () => {
    const configured = { CHAIN_GATEWAY_URL: GATEWAY };
    // A known last line first (wired), whatever ran before.
    wireSignedRecordsChainAtStartup(configured, gateway({}));
    warn.mockClear();
    info.mockClear();
    wireSignedRecordsChainAtStartup({}, gateway({}));
    wireSignedRecordsChainAtStartup({}, gateway({}));
    wireSignedRecordsChainAtStartup(configured, gateway({}));
    wireSignedRecordsChainAtStartup(configured, gateway({}));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[NOT WIRED\]/);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/^\[WIRED\]/);
  });
});

describe('signedRecordsChainOf', () => {
  afterEach(() => {
    wireSignedRecordsChain(null);
  });

  it("anchors at the answering node's finalized height when the pin has no block time", async () => {
    wireSignedRecordsChain(
      signedRecordsChainOf(
        gateway({
          headHeight: 105,
          finalizedHeight: 104,
          finalizedTime: null,
          nodeFinalizedHeight: 101,
          nodeFinalizedTime: FINALIZED_AT
        })
      )
    );
    await expect(recordAnchorService.getAnchor()).resolves.toEqual({
      anchor: 101,
      headHeight: 105,
      finalizedTime: FINALIZED_AT,
      maxAnchorLag: 120
    });
  });

  it('never anchors below a height it served: a lagging node, then no block time at all', async () => {
    wireSignedRecordsChain(
      signedRecordsChainOf(
        gateway(
          {
            headHeight: 106,
            finalizedHeight: 104,
            finalizedTime: FINALIZED_AT
          },
          {
            headHeight: 106,
            finalizedHeight: 104,
            finalizedTime: null,
            nodeFinalizedHeight: 101,
            nodeFinalizedTime: FINALIZED_AT - 90_000
          },
          { headHeight: 107, finalizedHeight: 105, finalizedTime: null },
          {
            headHeight: 109,
            finalizedHeight: 107,
            finalizedTime: FINALIZED_AT + 90_000
          }
        )
      )
    );
    expect(await anchors(4)).toEqual([104, 104, 104, 107]);
  });

  it('keeps each network its own height when a node answers for another network and back', async () => {
    const other = `0x${'99'.repeat(32)}`;
    wireSignedRecordsChain(
      signedRecordsChainOf(
        gateway(
          {
            headHeight: 1002,
            finalizedHeight: 1000,
            finalizedTime: FINALIZED_AT
          },
          {
            network: other,
            headHeight: 7,
            finalizedHeight: 5,
            finalizedTime: FINALIZED_AT + 30_000
          },
          {
            headHeight: 1000,
            finalizedHeight: 998,
            finalizedTime: FINALIZED_AT - 60_000
          }
        )
      )
    );
    expect(await anchors(3)).toEqual([1000, 5, 1000]);
  });

  it('starts over on another network (a relaunch)', async () => {
    wireSignedRecordsChain(
      signedRecordsChainOf(
        gateway(
          {
            headHeight: 106,
            finalizedHeight: 104,
            finalizedTime: FINALIZED_AT
          },
          {
            network: `0x${'99'.repeat(32)}`,
            headHeight: 7,
            finalizedHeight: 5,
            finalizedTime: FINALIZED_AT + 60_000
          }
        )
      )
    );
    expect(await anchors(2)).toEqual([104, 5]);
  });

  it('answers 503 ANCHOR_UNAVAILABLE, saying why, for a first head with no finalized block time', async () => {
    wireSignedRecordsChain(
      signedRecordsChainOf(
        gateway({ headHeight: 105, finalizedHeight: 104, finalizedTime: null })
      )
    );
    await expect(recordAnchorService.getAnchor()).rejects.toMatchObject({
      message:
        'The chain gateway gave no finalized block time, so there is no anchor height',
      code: 'ANCHOR_UNAVAILABLE'
    });
  });

  it("logs a failed read's cause once at warn until a read succeeds", async () => {
    const warn = jest
      .spyOn(Logger.get('SIGNED_RECORDS_ANCHOR'), 'warn')
      .mockImplementation(() => undefined);
    const down = Object.assign(new Error('GET /v1/status gave up'), {
      code: 'network'
    });
    let fail = true;
    const client = gateway({
      headHeight: 102,
      finalizedHeight: 100,
      finalizedTime: FINALIZED_AT
    });
    const getHead = client.getHead;
    client.getHead = async () => {
      if (fail) throw down;
      return getHead();
    };
    wireSignedRecordsChain(signedRecordsChainOf(client));
    await expect(recordAnchorService.getAnchor()).rejects.toMatchObject({
      message: 'The chain gateway did not answer, so there is no anchor height'
    });
    await expect(recordAnchorService.getAnchor()).rejects.toThrow();
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[ANCHOR READ FAILED] [network] [GET /v1/status gave up]'
    ]);
    fail = false;
    await recordAnchorService.getAnchor();
    fail = true;
    await expect(recordAnchorService.getAnchor()).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("anchors from the real client's head, read through its status route", async () => {
    const finalized = {
      at: 'finalized',
      height: 1000,
      root: `0x${'11'.repeat(32)}`,
      slot: 1010,
      time: FINALIZED_AT,
      finalizedHeight: 1000,
      headHeight: 1003,
      network: NETWORK
    };
    const body = JSON.stringify({
      read: { ...finalized, at: 'head', height: 1003 },
      data: {
        api: '1',
        node: 'rc',
        ready: true,
        head: { ...finalized, at: 'head', height: 1003 },
        finalized,
        pinnable: { from: 937, to: 1000 },
        ruleVersion: 6
      },
      next: null
    });
    const paths: string[] = [];
    const client = new ChainGatewayClient(() => ({
      baseUrl: GATEWAY,
      serviceKey: null,
      timeoutMs: 1_000,
      retries: 0,
      headTtlMs: 2_000,
      cacheEntries: 10,
      fetchImpl: async (url) => {
        paths.push(new URL(url).pathname);
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => {
            const bytes = Buffer.from(body);
            return bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer;
          }
        };
      }
    }));
    wireSignedRecordsChain(signedRecordsChainOf(client));
    await expect(recordAnchorService.getAnchor()).resolves.toEqual({
      anchor: 1000,
      headHeight: 1003,
      finalizedTime: FINALIZED_AT,
      maxAnchorLag: 120
    });
    expect(paths).toEqual(['/v1/status']);
  });
});
