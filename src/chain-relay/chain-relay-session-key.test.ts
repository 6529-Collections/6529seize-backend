import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import { ChainSubmitRequest } from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import { RateLimitConfig } from '@/api/rate-limiting/rate-limiting.utils';
import { rateLimitingService } from '@/api/rate-limiting/rate-limiting.service';
import { readEnvelopeHead, splitSingleSignature } from './chain-envelope';
import { RelayRateLimits } from './chain-relay-limits';
import {
  ChainRelayService,
  RelaySubmitRequest,
  SESSION_KEY_OPS
} from './chain-relay.service';
import { join } from './identity-join.fixtures';
import { ChainPendingOperationsDb } from './chain-pending-operations.db';

// These tests relay waves operations (votes, poll ballots) as after the
// waves switch-on; chain-relay-switch-on.test.ts covers the time before.
const WAVES_ON_CHAIN = 'FEATURE_WAVES_ON_CHAIN';
let wavesOnChain: string | undefined;
beforeAll(() => {
  wavesOnChain = process.env[WAVES_ON_CHAIN];
  process.env[WAVES_ON_CHAIN] = 'true';
});
afterAll(() => {
  if (wavesOnChain === undefined) delete process.env[WAVES_ON_CHAIN];
  else process.env[WAVES_ON_CHAIN] = wavesOnChain;
});

/**
 * The chain specification's worked example of a VOTE_SET signed by an
 * Ed25519 session key (keyType 2, authRef = its grant), on its example
 * devnet network.
 */
const E3_UNSIGNED = [
  '0x4001000153929f81f84ac199d1155e0cff0ae25cc43ca45d7434abdabf675c58',
  '3f1c02b50000000121724a4e681f9f33c84ff9d9cd000c8da3e5cb8c788be52a',
  '1d8c39ecef5b626d022a5dd5dcdeb155ddb00d6e9ec5392e2bf843cf1835930f',
  '78213e977c2ccfe03e0196a33983c6ec145d1f014e5436159a8224c0c74d828c',
  '69a035837a68c6b5ab9b000000000000000000000000000001a3185c50000000',
  '01a318933e800000000000000000000000000000000000000000000000002dc6',
  'c000000000000000000000000000000000060600015b7094b86baba5bf5ee242',
  '3289410a82c322681e6de97660612061993436cb0000000001242dc8ed1a0160',
  '5c10a0a663c2a96cd5aa6fb1bb2b96e287e796bcf87c0fae6e00000000000000',
  'fa000000000000000001'
].join('');

const PROFILE_REPLACE = 0x0102;
const VOTE_SET = 0x0606;
const WAVE_CREATE = 0x0501;

const NETWORK = '0x' + '5a'.repeat(32);
const PRINCIPAL = '0x' + 'a1'.repeat(32);
const OTHER_PRINCIPAL = '0x' + 'b2'.repeat(32);
const GRANT = '0x' + 'c3'.repeat(32);
const KEY_ID = '0x' + 'd4'.repeat(32);
const VOTER = '0x' + '1a'.repeat(20);
const VOTER_2 = '0x' + '4d'.repeat(20);
const OTHER_WALLET = '0x' + '2b'.repeat(20);
const UNBOUND = '0x' + '3c'.repeat(20);
const ED_SIG = '0x' + 'e5'.repeat(64);
const SECP_SIG = '0x' + '1b'.repeat(65);
const TX = '0x' + 'f0'.repeat(32);
const ADDRESS_1 = '192.0.2.10';
const ADDRESS_2 = '198.51.100.7';

const ONE_SIGNATURE = /carries one signature/;
const NOT_WALLET_OR_SESSION_KEY = /Only wallets \(keyType 1\) and session keys/;
const NOT_A_SESSION_OP = 'A session key may not sign this operation';

const hexOf = (value: number | bigint, bytes: number) =>
  BigInt(value)
    .toString(16)
    .padStart(bytes * 2, '0');

interface EnvelopeOptions {
  readonly opType: number;
  readonly keyType?: number;
  /** null: no authRef; default the session key's grant. */
  readonly authRef?: string | null;
  readonly principal?: string;
  /** A present ethRef: its number and hash (either may be zero). */
  readonly ethRef?: { readonly number: number; readonly hash: string };
  readonly sponsorRef?: string;
  readonly body?: string;
}

/** A transaction's unsigned bytes, made-up values. */
function envelope(o: EnvelopeOptions): string {
  const keyType = o.keyType ?? 2;
  const authRef = o.authRef === undefined ? GRANT : o.authRef;
  return (
    '0x' +
    [
      '4001',
      '0001',
      NETWORK.slice(2),
      hexOf(7, 4),
      (o.principal ?? PRINCIPAL).slice(2),
      hexOf(keyType, 1),
      keyType === 1 ? '00'.repeat(12) + VOTER.slice(2) : KEY_ID.slice(2),
      authRef ? '01' + authRef.slice(2) : '00',
      hexOf(0, 4),
      hexOf(3, 8),
      hexOf(1_800_000_000_000, 8),
      hexOf(1_800_003_600_000, 8),
      o.ethRef
        ? '01' + hexOf(o.ethRef.number, 8) + o.ethRef.hash.slice(2)
        : '00',
      '03',
      o.sponsorRef ? '01' + o.sponsorRef.slice(2) : '00',
      hexOf(BigInt('1000000000000000000'), 16),
      hexOf(100_000, 8),
      hexOf(0, 16),
      hexOf(o.opType, 2),
      '0001',
      o.body ?? 'ab'.repeat(85)
    ].join('')
  );
}

interface Entry {
  readonly role: number;
  readonly keyType: number;
  readonly sig: string;
  readonly proof?: string;
}

/** The canonical encoding of a signature list. */
function signatureList(entries: Entry[]): string {
  return (
    hexOf(entries.length, 4) +
    entries
      .map((it) => {
        const sig = it.sig.slice(2);
        const proof = (it.proof ?? '0x').slice(2);
        return (
          hexOf(it.role, 1) +
          hexOf(it.keyType, 1) +
          hexOf(sig.length / 2, 4) +
          sig +
          hexOf(proof.length / 2, 4) +
          proof
        );
      })
      .join('')
  );
}

/** The whole SignedTx: unsigned bytes, then one role-0 signature entry. */
function signed(unsigned: string, keyType = 2, sig = ED_SIG): string {
  return unsigned + signatureList([{ role: 0, keyType, sig }]);
}

/** An Ed25519 session key's operation, as unsigned bytes and a signature. */
const byEdKey = (opType: number, sig = ED_SIG) => ({
  unsigned: envelope({ opType }),
  signatures: [{ role: 0, keyType: 2, sig }]
});

/** A secp256k1 session key's (keyType 1 with its grant in authRef). */
const bySecpKey = (opType: number) => ({
  unsigned: envelope({ opType, keyType: 1 }),
  signatures: [{ role: 0, keyType: 1, sig: SECP_SIG }]
});

/** A wallet's (keyType 1, no authRef). */
const byWallet = (opType: number) => ({
  unsigned: envelope({ opType, keyType: 1, authRef: null }),
  signatures: [{ role: 0, keyType: 1, sig: SECP_SIG }]
});

class FakeLimiter {
  readonly counts = new Map<string, number>();
  readonly seen: string[] = [];

  async checkRateLimit(identifier: string, config: RateLimitConfig) {
    const count = (this.counts.get(identifier) ?? 0) + 1;
    this.counts.set(identifier, count);
    this.seen.push(identifier);
    return {
      allowed: count <= config.burst,
      remaining: Math.max(0, config.burst - count),
      resetTime: Date.now() + 5_000,
      limit: config.burst
    };
  }
}

const budget = (burst: number): RateLimitConfig => ({
  burst,
  sustainedRps: 1,
  sustainedWindowSeconds: 60
});

function setup(
  bursts: Partial<Record<keyof RelayRateLimits, number>> = {},
  db: unknown = {}
) {
  const identities: Record<string, string> = {
    [VOTER]: PRINCIPAL,
    [VOTER_2]: PRINCIPAL,
    [OTHER_WALLET]: OTHER_PRINCIPAL
  };
  const gateway = {
    submit: jest.fn(async (_request: ChainSubmitRequest) => ({
      txId: TX,
      accepted: true
    })),
    getIdentityByWallet: jest.fn(async (wallet: string) =>
      identities[wallet] ? { principalId: identities[wallet] } : null
    )
  };
  const limiter = new FakeLimiter();
  const service = new TestRelay(
    gateway as never,
    db as ChainPendingOperationsDb,
    () => 1_000_000,
    {},
    limiter,
    () => ({
      wallet: budget(bursts.wallet ?? 100),
      address: budget(bursts.address ?? 100),
      principal: budget(bursts.principal ?? 100)
    })
  );
  return { gateway, limiter, service };
}

/**
 * The relay with every submit carrying its draft's txId, which
 * POST /chain/submit requires in both forms; these tests are of the rest.
 */
class TestRelay extends ChainRelayService {
  submit(
    request: ChainSubmitRequest & { readonly txId?: string },
    caller?: string,
    address?: string | null
  ) {
    return super.submit(
      { txId: TX, ...request } as RelaySubmitRequest,
      caller,
      address
    );
  }
}

const failure = (status: number | null, retryAfterMs?: number) =>
  Object.assign(
    new ChainGatewayError(
      `/v1/x: code ${status}`,
      status,
      status === null ? 'network' : `http_${status}`,
      '/v1/x'
    ),
    retryAfterMs === undefined ? {} : { retryAfterMs }
  );

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error as CustomApiCompliantException
  );

describe('readEnvelopeHead', () => {
  it("reads the specification's VOTE_SET by a session key", () => {
    expect((E3_UNSIGNED.length - 2) / 2).toBe(298);
    expect(readEnvelopeHead(E3_UNSIGNED)).toEqual({
      networkId:
        '0x53929f81f84ac199d1155e0cff0ae25cc43ca45d7434abdabf675c583f1c02b5',
      ruleVersion: 1,
      principal:
        '0x21724a4e681f9f33c84ff9d9cd000c8da3e5cb8c788be52a1d8c39ecef5b626d',
      keyType: 2,
      keyId:
        '0x2a5dd5dcdeb155ddb00d6e9ec5392e2bf843cf1835930f78213e977c2ccfe03e',
      authRef:
        '0x96a33983c6ec145d1f014e5436159a8224c0c74d828c69a035837a68c6b5ab9b',
      opType: VOTE_SET,
      opVersion: 1
    });
  });

  it('steps over a present ethRef and sponsorRef', () => {
    for (const ethRef of [
      { number: 19_000_000, hash: '0x' + 'e7'.repeat(32) },
      { number: 5, hash: '0x' + '00'.repeat(32) },
      { number: 0, hash: '0x' + '01'.repeat(32) }
    ]) {
      expect(
        readEnvelopeHead(
          envelope({
            opType: WAVE_CREATE,
            keyType: 1,
            authRef: null,
            ethRef,
            sponsorRef: OTHER_PRINCIPAL
          })
        )
      ).toMatchObject({
        networkId: NETWORK,
        ruleVersion: 7,
        principal: PRINCIPAL,
        keyType: 1,
        keyId: '0x' + '00'.repeat(12) + VOTER.slice(2),
        authRef: null,
        opType: WAVE_CREATE,
        opVersion: 1
      });
    }
    expect(readEnvelopeHead(signed(E3_UNSIGNED))?.opType).toBe(VOTE_SET);
  });

  it('is null for bytes that are not a SignedTx v1', () => {
    const vote = envelope({ opType: VOTE_SET });
    const authRefAt = 2 + 2 * (4 + 32 + 4 + 32 + 1 + 32);
    for (const bytes of [
      '0xabcd',
      'nothex',
      '0x' + '4002' + vote.slice(6),
      '0x' + '4001' + '0002' + vote.slice(10),
      vote.slice(0, authRefAt) + '02' + vote.slice(authRefAt + 2),
      envelope({ opType: VOTE_SET, authRef: '0x' + '00'.repeat(32) }),
      envelope({
        opType: VOTE_SET,
        ethRef: { number: 0, hash: '0x' + '00'.repeat(32) }
      }),
      vote.slice(0, vote.length - 2 * 85 - 4)
    ]) {
      expect(readEnvelopeHead(bytes)).toBeNull();
    }
  });
});

describe('splitSingleSignature', () => {
  it('splits a signed operation into its unsigned bytes and its one entry', () => {
    const vote = envelope({ opType: VOTE_SET });
    expect(splitSingleSignature(signed(vote), 64)).toEqual({
      unsigned: vote,
      signature: { role: 0, keyType: 2, sig: ED_SIG }
    });
    expect(splitSingleSignature(signed(vote, 1, SECP_SIG), 65)).toEqual({
      unsigned: vote,
      signature: { role: 0, keyType: 1, sig: SECP_SIG }
    });
  });

  it('is null for any other list, or bytes after it', () => {
    const vote = envelope({ opType: VOTE_SET });
    for (const bytes of [
      vote + signatureList([]),
      vote +
        signatureList([
          { role: 0, keyType: 2, sig: ED_SIG },
          { role: 1, keyType: 2, sig: ED_SIG }
        ]),
      vote +
        signatureList([{ role: 0, keyType: 2, sig: ED_SIG, proof: '0x01' }]),
      signed(vote) + 'deadbeef',
      // A proof length with no proof after it.
      signed(vote).slice(0, -8) + '00000001',
      signed(vote, 1, SECP_SIG),
      signatureList([{ role: 0, keyType: 2, sig: ED_SIG }])
    ]) {
      expect(splitSingleSignature(bytes, 64)).toBeNull();
    }
  });
});

describe('ChainRelayService with session keys', () => {
  it("relays every operation a session key may sign, for the caller's identity", async () => {
    const { service, gateway } = setup();
    expect(Array.from(SESSION_KEY_OPS)).toEqual([
      0x0102, 0x0201, 0x0303, 0x0606, 0x0608, 0x0701
    ]);
    const requests: ChainSubmitRequest[] = [];
    for (const opType of Array.from(SESSION_KEY_OPS)) {
      requests.push(
        byEdKey(opType),
        bySecpKey(opType),
        { signed: signed(envelope({ opType })) },
        { signed: signed(envelope({ opType, keyType: 1 }), 1, SECP_SIG) }
      );
    }
    for (const request of requests) {
      expect(await service.submit(request, VOTER, ADDRESS_1)).toEqual({
        txId: TX,
        accepted: true,
        outcome: 'accepted'
      });
      expect(gateway.submit).toHaveBeenLastCalledWith({ ...request, txId: TX });
    }
    expect(gateway.submit).toHaveBeenCalledTimes(24);
    expect(gateway.getIdentityByWallet).toHaveBeenCalledTimes(24);
    expect(gateway.getIdentityByWallet).toHaveBeenCalledWith(VOTER);
  });

  it('refuses every other operation a session key signs', async () => {
    const { service, gateway } = setup();
    // WAVE_CREATE, SUBMISSION_CREATE, SETTLEMENT_REQUEST, VOTE_RELEASE,
    // DECISION_CREATE, GROUP_CREATE, CAPABILITY_GRANT, BALANCE_TRANSFER
    for (const opType of [
      WAVE_CREATE,
      0x0604,
      0x0609,
      0x060a,
      0x0610,
      0x0401,
      0x0301,
      0x0901
    ]) {
      for (const request of [
        byEdKey(opType),
        bySecpKey(opType),
        { signed: signed(envelope({ opType })) }
      ]) {
        await expect(service.submit(request, VOTER)).rejects.toThrow(
          NOT_A_SESSION_OP
        );
      }
    }
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(gateway.getIdentityByWallet).not.toHaveBeenCalled();
  });

  it("refuses a session key's operation in any other shape, saying which check", async () => {
    const { service, gateway } = setup();
    const vote = envelope({ opType: VOTE_SET });
    const cases: [ChainSubmitRequest, RegExp | string][] = [
      [
        { unsigned: vote, signatures: [{ role: 1, keyType: 2, sig: ED_SIG }] },
        ONE_SIGNATURE
      ],
      [
        {
          unsigned: vote,
          signatures: [
            { role: 0, keyType: 2, sig: ED_SIG },
            { role: 1, keyType: 1, sig: SECP_SIG }
          ]
        },
        ONE_SIGNATURE
      ],
      [byEdKey(VOTE_SET, SECP_SIG), ONE_SIGNATURE],
      [
        {
          unsigned: vote,
          signatures: [{ role: 0, keyType: 1, sig: SECP_SIG }]
        },
        ONE_SIGNATURE
      ],
      [
        {
          unsigned: vote,
          signatures: [{ role: 0, keyType: 3, sig: SECP_SIG }]
        },
        ONE_SIGNATURE
      ],
      [
        {
          unsigned: envelope({ opType: VOTE_SET, keyType: 1 }),
          signatures: [{ role: 0, keyType: 1, sig: ED_SIG }]
        },
        ONE_SIGNATURE
      ],
      [
        {
          unsigned: envelope({ opType: VOTE_SET, authRef: null }),
          signatures: [{ role: 0, keyType: 2, sig: ED_SIG }]
        },
        NOT_WALLET_OR_SESSION_KEY
      ],
      [
        { signed: signed(envelope({ opType: VOTE_SET, keyType: 5 })) },
        NOT_WALLET_OR_SESSION_KEY
      ],
      [
        {
          unsigned: envelope({
            opType: VOTE_SET,
            principal: '0x' + '00'.repeat(32)
          }),
          signatures: [{ role: 0, keyType: 2, sig: ED_SIG }]
        },
        'principal is zero'
      ],
      [
        {
          unsigned: '0x0102',
          signatures: [{ role: 0, keyType: 2, sig: ED_SIG }]
        },
        'not a 6529 Network transaction'
      ],
      // The signed form: the same checks on its signature list.
      [
        {
          signed:
            vote +
            signatureList([
              { role: 0, keyType: 1, sig: SECP_SIG },
              { role: 2, keyType: 1, sig: SECP_SIG }
            ])
        },
        ONE_SIGNATURE
      ],
      [{ signed: signed(vote) + 'deadbeef' }, ONE_SIGNATURE],
      [
        {
          signed:
            vote +
            signatureList([{ role: 0, keyType: 2, sig: ED_SIG, proof: '0x01' }])
        },
        ONE_SIGNATURE
      ],
      [
        {
          signed: vote + signatureList([{ role: 1, keyType: 2, sig: ED_SIG }])
        },
        ONE_SIGNATURE
      ],
      [{ signed: signed(vote, 1, SECP_SIG) }, ONE_SIGNATURE],
      [{ signed: signed(vote, 1, ED_SIG) }, ONE_SIGNATURE]
    ];
    for (const [request, message] of cases) {
      const error = await caught(service.submit(request, VOTER));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(message);
    }
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it("relays a session key's operation only for the signed-in wallet's identity", async () => {
    const { service, gateway } = setup();
    for (const caller of [OTHER_WALLET, UNBOUND, undefined]) {
      for (const request of [byEdKey(VOTE_SET), bySecpKey(PROFILE_REPLACE)]) {
        await expect(service.submit(request, caller)).rejects.toBeInstanceOf(
          ForbiddenException
        );
      }
    }
    expect(gateway.submit).not.toHaveBeenCalled();
    gateway.getIdentityByWallet.mockResolvedValueOnce({
      principalId: PRINCIPAL.toUpperCase().replace('0X', '0x')
    });
    await service.submit(byEdKey(VOTE_SET), VOTER);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('answers 422 only for the chain refusing the operation, else a retry', async () => {
    // The identity read: never a refusal of the operation.
    for (const [status, code, http] of [
      [400, 'CHAIN_UNAVAILABLE', 502],
      [401, 'CHAIN_UNAVAILABLE', 502],
      [403, 'CHAIN_UNAVAILABLE', 502],
      [404, 'CHAIN_UNAVAILABLE', 502],
      [422, 'CHAIN_UNAVAILABLE', 502],
      [500, 'CHAIN_UNAVAILABLE', 502],
      [null, 'CHAIN_UNAVAILABLE', 502],
      [429, 'CHAIN_BUSY', 503],
      [503, 'CHAIN_BUSY', 503]
    ] as const) {
      const { service, gateway } = setup();
      gateway.getIdentityByWallet.mockRejectedValueOnce(failure(status));
      const error = await caught(service.submit(byEdKey(VOTE_SET), VOTER));
      expect([error.code, error.getStatusCode()]).toEqual([code, http]);
      expect(gateway.submit).not.toHaveBeenCalled();
    }
    // The submit, for a session key's and a wallet's operation alike, by
    // the code the gateway client gives: only the node's refusal of the
    // operation is final; an unknown outcome is never sent again.
    for (const [status, clientCode, code, http, outcome] of [
      [422, 'inadmissible', 'CHAIN_REFUSED', 422, 'refused'],
      [400, 'bad_request', 'CHAIN_REFUSED', 422, 'refused'],
      [413, 'too_large', 'CHAIN_REFUSED', 422, 'refused'],
      [401, 'unauthorized', 'CHAIN_UNAVAILABLE', 502, 'not_taken'],
      [403, 'forbidden', 'CHAIN_UNAVAILABLE', 502, 'not_taken'],
      [504, 'outcome_unknown', 'CHAIN_OUTCOME_UNKNOWN', 502, 'unknown'],
      [null, 'network', 'CHAIN_UNAVAILABLE', 502, 'not_taken'],
      [429, 'rate_limited', 'CHAIN_BUSY', 503, 'not_taken'],
      [503, 'busy', 'CHAIN_BUSY', 503, 'not_taken']
    ] as const) {
      for (const request of [byEdKey(VOTE_SET), byWallet(WAVE_CREATE)]) {
        const { service, gateway } = setup();
        gateway.submit.mockRejectedValueOnce(
          new ChainGatewayError(
            '/v1/submit: no',
            status,
            clientCode,
            '/v1/submit'
          )
        );
        const error = await caught(service.submit(request, VOTER));
        expect([error.code, error.getStatusCode()]).toEqual([code, http]);
        expect(error.details).toMatchObject({ tx_id: TX, outcome });
      }
    }
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(failure(429, 2_000));
    const busy = await caught(service.submit(byWallet(WAVE_CREATE), VOTER));
    expect(busy).toMatchObject({ code: 'CHAIN_BUSY', retryAfterSeconds: 2 });
  });

  it('caps the whole transaction, signature list included', async () => {
    const { service, gateway } = setup();
    const unsignedOf = (bytes: number, keyType = 2) => {
      const empty = envelope({ opType: VOTE_SET, keyType, body: '' });
      const head = (empty.length - 2) / 2;
      return envelope({
        opType: VOTE_SET,
        keyType,
        body: 'ab'.repeat(bytes - head)
      });
    };
    // One Ed25519 entry is 78 bytes of list, a secp256k1 one 79.
    for (const request of [
      { unsigned: unsignedOf(4096 - 78), signatures: byEdKey(0).signatures },
      { signed: signed(unsignedOf(4096 - 78)) },
      {
        unsigned: unsignedOf(4096 - 79, 1),
        signatures: bySecpKey(0).signatures
      }
    ]) {
      await service.submit(request, VOTER);
    }
    expect(gateway.submit).toHaveBeenCalledTimes(3);
    for (const request of [
      { unsigned: unsignedOf(4096 - 77), signatures: byEdKey(0).signatures },
      { unsigned: unsignedOf(4096), signatures: byEdKey(0).signatures },
      { signed: signed(unsignedOf(4096 - 77)) },
      {
        unsigned: unsignedOf(4096 - 78, 1),
        signatures: bySecpKey(0).signatures
      },
      {
        unsigned: '0x' + 'ab'.repeat(128 * 1024 + 1),
        signatures: byWallet(0).signatures
      },
      { signed: '0x' + 'ab'.repeat(144 * 1024 + 1) }
    ]) {
      await expect(service.submit(request, VOTER)).rejects.toBeInstanceOf(
        BadRequestException
      );
    }
    expect(gateway.submit).toHaveBeenCalledTimes(3);
  });

  it('relays wallet-signed operations as before, with no identity read', async () => {
    const { service, gateway } = setup();
    const request = byWallet(WAVE_CREATE);
    await service.submit(request, OTHER_WALLET, ADDRESS_1);
    await service.submit({ signed: signed(request.unsigned, 1, SECP_SIG) });
    await service.submit({ signed: '0xabcd' }, UNBOUND);
    expect(gateway.submit).toHaveBeenCalledWith({ ...request, txId: TX });
    expect(gateway.submit).toHaveBeenCalledTimes(3);
    expect(gateway.getIdentityByWallet).not.toHaveBeenCalled();
    await expect(
      service.submit(
        { ...request, signatures: [{ role: 0, keyType: 1, sig: ED_SIG }] },
        VOTER
      )
    ).rejects.toThrow('A signature must be 65 bytes of 0x hex');
  });
});

describe('ChainRelayService rate limits', () => {
  it("limits each wallet's relayed writes, with Retry-After", async () => {
    const { service, gateway, limiter } = setup({ wallet: 3 });
    for (let i = 0; i < 3; i++) {
      await service.submit(byEdKey(VOTE_SET), VOTER, ADDRESS_1);
    }
    const limited = await caught(
      service.submit(byEdKey(VOTE_SET), VOTER, ADDRESS_1)
    );
    expect(limited.getStatusCode()).toBe(429);
    expect(limited).toMatchObject({
      code: 'CHAIN_RELAY_RATE_LIMITED',
      retryAfterSeconds: 5
    });
    expect(gateway.submit).toHaveBeenCalledTimes(3);
    expect(gateway.getIdentityByWallet).toHaveBeenCalledTimes(3);
    expect(limiter.counts.get(`chain-relay:wallet:${VOTER}`)).toBe(4);
    expect(limiter.counts.get(`chain-relay:address:${ADDRESS_1}`)).toBe(4);

    // A refused shape counts nothing.
    await expect(
      service.submit(byEdKey(WAVE_CREATE), OTHER_WALLET)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(limiter.counts.get(`chain-relay:wallet:${OTHER_WALLET}`)).toBe(
      undefined
    );
  });

  it('limits a source address however many wallets it signs in with', async () => {
    const { service, gateway } = setup({ address: 2 });
    await service.submit({ signed: '0xabcd' }, VOTER, ADDRESS_1);
    await service.submit({ signed: '0xabcd' }, OTHER_WALLET, ADDRESS_1);
    await expect(
      service.submit({ signed: '0xabcd' }, UNBOUND, ADDRESS_1)
    ).rejects.toMatchObject({ code: 'CHAIN_RELAY_RATE_LIMITED' });
    await service.submit({ signed: '0xabcd' }, UNBOUND, ADDRESS_2);
    expect(gateway.submit).toHaveBeenCalledTimes(3);
  });

  it("limits an identity's session-key operations across its wallets", async () => {
    const { service, gateway, limiter } = setup({ principal: 2 });
    await service.submit(byEdKey(VOTE_SET), VOTER);
    await service.submit(bySecpKey(VOTE_SET), VOTER_2);
    // Another identity's wallet is refused before the budget is touched.
    await expect(
      service.submit(byEdKey(VOTE_SET), OTHER_WALLET)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(limiter.counts.get(`chain-relay:principal:${PRINCIPAL}`)).toBe(2);
    await expect(
      service.submit(byEdKey(VOTE_SET), VOTER)
    ).rejects.toMatchObject({ code: 'CHAIN_RELAY_RATE_LIMITED' });
    // Wallet-signed operations don't use it.
    await service.submit(byWallet(WAVE_CREATE), VOTER);
    expect(gateway.submit).toHaveBeenCalledTimes(3);
  });

  it("counts the pending operations' writes in the same budgets", async () => {
    const expiresAt = 1_000_000 + 3_600_000;
    const { typedData, txId } = join({
      principal: PRINCIPAL,
      signer: VOTER,
      joiner: VOTER_2,
      expiresAt
    });
    const { service, limiter } = setup({ wallet: 0 });
    const input = {
      txId,
      opType: 'IDENTITY_JOIN',
      principal: PRINCIPAL,
      unsigned: '0x0102',
      typedData,
      expiresAt,
      required: [
        { role: 0, keyType: 1, signer: VOTER },
        { role: 4, keyType: 1, signer: VOTER_2 }
      ],
      signatures: [{ role: 0, keyType: 1, sig: SECP_SIG }]
    };
    for (const write of [
      () => service.createPending(input, VOTER, ADDRESS_1),
      () =>
        service.addSignature(
          txId,
          { role: 4, keyType: 1, sig: SECP_SIG },
          VOTER_2,
          ADDRESS_1
        ),
      () => service.retry(txId, VOTER, ADDRESS_1)
    ]) {
      await expect(write()).rejects.toMatchObject({
        code: 'CHAIN_RELAY_RATE_LIMITED'
      });
    }
    expect(limiter.seen).toEqual([
      `chain-relay:wallet:${VOTER}`,
      `chain-relay:address:${ADDRESS_1}`,
      `chain-relay:wallet:${VOTER_2}`,
      `chain-relay:address:${ADDRESS_1}`,
      `chain-relay:wallet:${VOTER}`,
      `chain-relay:address:${ADDRESS_1}`
    ]);
  });

  it('admits every write without Redis, and logs that once', async () => {
    const warn = jest.spyOn(Logger.get('CHAIN_RELAY'), 'warn');
    const gateway = {
      submit: jest.fn(async () => ({ txId: TX, accepted: true })),
      getIdentityByWallet: jest.fn(async () => ({ principalId: PRINCIPAL }))
    };
    const service = new TestRelay(
      gateway as never,
      {} as never,
      () => 1_000_000,
      {},
      rateLimitingService,
      () => ({ wallet: budget(1), address: budget(1), principal: budget(1) })
    );
    for (let i = 0; i < 5; i++) {
      await service.submit(byEdKey(VOTE_SET), VOTER, ADDRESS_1);
    }
    expect(gateway.submit).toHaveBeenCalledTimes(5);
    const notEnforced = warn.mock.calls.filter(([message]) =>
      String(message).includes('RATE LIMIT NOT ENFORCED')
    );
    expect(notEnforced).toHaveLength(1);
    warn.mockRestore();
  });
});
