import { TypedDataEncoder, Wallet } from 'ethers';
import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import {
  ChainPendingOperationsDb,
  PendingOperation,
  PendingStatus
} from './chain-pending-operations.db';
import {
  ChainRelayService,
  ChainTypedData,
  maySeeSignatures,
  PendingOperationInput,
  submitFailure,
  typedDataDigest,
  walletSignerOf
} from './chain-relay.service';

/** A join's typed data, as the gateway drafts it; TX is its EIP-712 digest. */
const TYPED: ChainTypedData = {
  domain: { name: '6529 Network', version: '1', chainId: 1 },
  primaryType: 'IdentityJoin',
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }
    ],
    IdentityJoin: [
      { name: 'principal', type: 'bytes32' },
      { name: 'wallet', type: 'address' },
      { name: 'nonce', type: 'uint64' }
    ]
  },
  message: {
    principal: '0x' + 'ab'.repeat(32),
    wallet: '0x' + '22'.repeat(20),
    nonce: 7
  }
};
const TX = TypedDataEncoder.hash(
  TYPED.domain as never,
  { IdentityJoin: TYPED.types.IdentityJoin },
  TYPED.message
).toLowerCase();
const OTHER_TX = '0x' + 'cd'.repeat(32);
const ANCHOR = new Wallet('0x' + '11'.repeat(32));
const JOINER = new Wallet('0x' + '22'.repeat(32));
const STRANGER = new Wallet('0x' + '33'.repeat(32));
const sign = (wallet: Wallet, txId = TX) =>
  wallet.signingKey.sign(txId).serialized;
const addr = (wallet: Wallet) => wallet.address.toLowerCase();
const joinerSignature = () => ({ role: 4, keyType: 1, sig: sign(JOINER) });

/**
 * The relay's tables in memory. Transactions run one at a time, as the row
 * lock a real one takes on the operation would make them. `onFind` runs
 * after each read, to land another request at that point.
 */
class FakeDb {
  ops = new Map<string, PendingOperation>();
  onFind: (() => void) | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  async executeNativeQueriesInTransaction<T>(
    fn: (c: unknown) => Promise<T>
  ): Promise<T> {
    const run = this.lock.then(() => fn({}));
    this.lock = run.catch(() => undefined);
    return run;
  }
  async find(txId: string) {
    const op = this.ops.get(txId);
    this.onFind?.();
    return op ? { ...op, signers: op.signers.map((it) => ({ ...it })) } : null;
  }
  async insert(op: PendingOperation) {
    this.ops.set(op.tx_id, op);
  }
  async setSignature(txId: string, role: number, sig: string, now: number) {
    const op = this.ops.get(txId)!;
    this.ops.set(txId, {
      ...op,
      signers: op.signers.map((it) =>
        it.role === role ? { ...it, sig, signed_at: now } : it
      )
    });
  }
  async clearSignatures(txId: string) {
    const op = this.ops.get(txId)!;
    this.ops.set(txId, {
      ...op,
      signers: op.signers.map((it) => ({ ...it, sig: null }))
    });
  }
  async setStatus(
    txId: string,
    change: { from: PendingStatus; to: PendingStatus },
    fields: { result_json?: string | null; last_error?: string | null },
    now: number
  ) {
    const op = this.ops.get(txId);
    if (!op || op.status !== change.from) return false;
    this.ops.set(txId, {
      ...op,
      status: change.to,
      result_json: fields.result_json ?? null,
      last_error: fields.last_error ?? null,
      updated_at: now
    });
    return true;
  }
  async awaiting(wallet: string, now: number) {
    return Array.from(this.ops.values())
      .filter(
        (op) =>
          op.status === 'PENDING' &&
          op.expires_at > now &&
          op.signers.some((it) => it.signer === wallet && !it.sig)
      )
      .map((op) => op.tx_id);
  }
}

function setup() {
  const db = new FakeDb();
  const gateway = {
    submit: jest.fn(async (_request: unknown) => ({ txId: TX, accepted: true }))
  };
  let now = 1_000_000;
  const service = new ChainRelayService(
    gateway as never,
    db as unknown as ChainPendingOperationsDb,
    () => now
  );
  return {
    db,
    gateway,
    service,
    tick: (ms: number) => {
      now += ms;
    }
  };
}

function joinInput(
  signatures = [{ role: 0, keyType: 1, sig: sign(ANCHOR) }]
): PendingOperationInput {
  return {
    txId: TX,
    opType: 'IDENTITY_JOIN',
    principal: '0x' + 'ab'.repeat(32),
    unsigned: '0x0102',
    typedData: TYPED,
    expiresAt: 1_000_000 + 3_600_000,
    required: [
      { role: 0, keyType: 1, signer: ANCHOR.address },
      { role: 4, keyType: 1, signer: JOINER.address }
    ],
    signatures
  };
}

const bothSigned = () =>
  joinInput([
    { role: 0, keyType: 1, sig: sign(ANCHOR) },
    { role: 4, keyType: 1, sig: sign(JOINER) }
  ]);

/** The client's outcome_unknown, as it throws it after a 504. */
function outcomeUnknown(txId = TX) {
  const error = new ChainGatewayError(
    `/v1/submit: the outcome is unknown (http_504): ask getTx for ${txId}`,
    504,
    'outcome_unknown',
    '/v1/submit'
  );
  error.txId = txId;
  return error;
}

describe('typedDataDigest', () => {
  it('is the EIP-712 digest a wallet signs', () => {
    expect(typedDataDigest(TYPED)).toBe(TX);
    expect(
      typedDataDigest({ ...TYPED, message: { ...TYPED.message, nonce: 8 } })
    ).not.toBe(TX);
    expect(typedDataDigest({ ...TYPED, types: {} })).toBeNull();
  });
});

describe('walletSignerOf', () => {
  it('recovers the wallet that signed the digest', () => {
    expect(walletSignerOf(TX, sign(JOINER))).toBe(addr(JOINER));
    expect(walletSignerOf(TX, '0x' + '00'.repeat(65))).toBeNull();
  });
});

describe('ChainRelayService pending operations', () => {
  it('holds a join until the joining wallet signs, then relays it with its txId', async () => {
    const { service, gateway } = setup();
    const created = await service.createPending(joinInput(), ANCHOR.address);
    expect(created.status).toBe('PENDING');
    expect(created.signers.map((it) => [it.role, !!it.sig])).toEqual([
      [0, true],
      [4, false]
    ]);
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(
      (await service.awaiting(JOINER.address)).map((it) => it.tx_id)
    ).toEqual([TX]);
    expect(await service.awaiting(ANCHOR.address)).toEqual([]);

    const done = await service.addSignature(
      TX,
      joinerSignature(),
      JOINER.address
    );
    expect(done.status).toBe('SUBMITTED');
    expect(JSON.parse(done.result_json!)).toEqual({ txId: TX, accepted: true });
    expect(done.last_error).toBeNull();
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    expect(gateway.submit).toHaveBeenCalledWith({
      unsigned: '0x0102',
      signatures: [
        { role: 0, keyType: 1, sig: sign(ANCHOR) },
        { role: 4, keyType: 1, sig: sign(JOINER) }
      ],
      txId: TX
    });
    expect(await service.awaiting(JOINER.address)).toEqual([]);
  });

  it('relays at once when every signature comes with it', async () => {
    const { service, gateway } = setup();
    const op = await service.createPending(bothSigned(), JOINER.address);
    expect(op.status).toBe('SUBMITTED');
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    expect(gateway.submit.mock.calls[0][0]).toMatchObject({ txId: TX });
  });

  it('refuses a signature by another wallet', async () => {
    const { service } = setup();
    await expect(
      service.createPending(
        joinInput([{ role: 0, keyType: 1, sig: sign(STRANGER) }]),
        ANCHOR.address
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.createPending(joinInput(), ANCHOR.address);
    await expect(
      service.addSignature(
        TX,
        { role: 4, keyType: 1, sig: sign(STRANGER) },
        JOINER.address
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.addSignature(TX, joinerSignature(), STRANGER.address)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('takes an operation only from a signer who has signed it', async () => {
    const { service } = setup();
    await expect(
      service.createPending(joinInput(), STRANGER.address)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createPending(
        joinInput([{ role: 0, keyType: 1, sig: sign(ANCHOR) }]),
        JOINER.address
      )
    ).rejects.toThrow('Sign the operation before sharing it');
  });

  it('adds to a held operation only with its own signer list', async () => {
    const { service, gateway, db } = setup();
    await service.createPending(joinInput(), ANCHOR.address);
    // The same txId, posted with the stranger in the joining role: its
    // signature must not fill the joining wallet's role.
    const input = joinInput([{ role: 4, keyType: 1, sig: sign(STRANGER) }]);
    await expect(
      service.createPending(
        {
          ...input,
          required: [
            { role: 0, keyType: 1, signer: ANCHOR.address },
            { role: 4, keyType: 1, signer: STRANGER.address }
          ]
        },
        STRANGER.address
      )
    ).rejects.toThrow('held with other signers');
    expect(db.ops.get(TX)!.signers[1].sig).toBeNull();
    expect(gateway.submit).not.toHaveBeenCalled();
    // The joining wallet posting the same draft with its signature completes it.
    const done = await service.createPending(
      joinInput([joinerSignature()]),
      JOINER.address
    );
    expect(done.status).toBe('SUBMITTED');
  });

  it('refuses expired, malformed and oversized input', async () => {
    const { service } = setup();
    for (const input of [
      { ...joinInput(), expiresAt: 999_999 },
      { ...joinInput(), expiresAt: 1_000_000 + 8 * 24 * 3_600_000 },
      { ...joinInput(), txId: '0x12' },
      {
        ...joinInput(),
        typedData: { ...TYPED, message: { ...TYPED.message, nonce: 9 } }
      },
      { ...joinInput(), unsigned: '0xabc' },
      {
        ...joinInput(),
        required: [
          { role: 0, keyType: 1, signer: ANCHOR.address },
          { role: 0, keyType: 1, signer: JOINER.address }
        ]
      },
      {
        ...joinInput(),
        required: [{ role: 0, keyType: 2, signer: ANCHOR.address }]
      }
    ]) {
      await expect(
        service.createPending(input, ANCHOR.address)
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('keeps a complete operation pending while the chain is unreachable', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError('busy', 503, 'busy', '/v1/submit')
    );
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    expect(op.status).toBe('PENDING');
    expect(op.last_error).toContain('busy');
    expect(op.result_json).toBeNull();
    const retried = await service.retry(TX, JOINER.address);
    expect(retried.status).toBe('SUBMITTED');
    expect(gateway.submit).toHaveBeenCalledTimes(2);
  });

  it('keeps it pending when the gateway refuses this backend, not the operation', async () => {
    const { service, gateway } = setup();
    const refusal = new ChainGatewayError(
      'bad key',
      401,
      'unauthorized',
      '/v1/submit'
    );
    refusal.txId = TX;
    gateway.submit.mockRejectedValueOnce(refusal);
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    expect(op.status).toBe('PENDING');
    expect((await service.retry(TX, ANCHOR.address)).status).toBe('SUBMITTED');
  });

  it('marks an operation the chain refuses as failed', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError(
        '0x2101 ALREADY_BOUND',
        422,
        'inadmissible',
        '/v1/submit'
      )
    );
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    expect(op.status).toBe('FAILED');
    expect(op.last_error).toContain('ALREADY_BOUND');
    await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
      'The operation is failed'
    );
  });

  it('never sends a join again once its outcome is unknown', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(outcomeUnknown());
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    expect(op.status).toBe('SUBMITTED');
    expect(JSON.parse(op.result_json!)).toEqual({
      txId: TX,
      outcome: 'unknown'
    });
    expect(op.last_error).toContain(`may have taken ${TX}`);
    await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
      'The operation is submitted'
    );
    await expect(service.cancel(TX, JOINER.address)).rejects.toThrow(
      'The operation is submitted'
    );
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('takes an answer of another transaction as an unknown outcome, naming both', async () => {
    // As the client throws it, and as a bare bad_answer.
    const converted = outcomeUnknown(OTHER_TX);
    converted.message = `/v1/submit: the outcome is unknown (bad_answer): ask getTx for ${OTHER_TX}`;
    const bare = new ChainGatewayError(
      `/v1/submit: the node took ${OTHER_TX}, not ${TX}`,
      200,
      'bad_answer',
      '/v1/submit'
    );
    for (const error of [converted, bare]) {
      const { service, gateway } = setup();
      gateway.submit.mockRejectedValueOnce(error);
      const op = await service.createPending(bothSigned(), ANCHOR.address);
      expect(op.status).toBe('SUBMITTED');
      expect(JSON.parse(op.result_json!)).toEqual({
        txId: TX,
        outcome: 'unknown',
        nodeTxId: OTHER_TX
      });
      expect(op.last_error).toContain(`took ${OTHER_TX}, not ${TX}`);
      await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
        'submitted'
      );
      expect(gateway.submit).toHaveBeenCalledTimes(1);
    }
  });

  it('sends a complete operation once when two requests complete it at once', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError('busy', 503, 'busy', '/v1/submit')
    );
    await service.createPending(bothSigned(), ANCHOR.address);
    const both = await Promise.all([
      service.retry(TX, ANCHOR.address),
      service.retry(TX, JOINER.address).catch((e: unknown) => e)
    ]);
    expect((both[0] as PendingOperation).status).toBe('SUBMITTED');
    expect(gateway.submit).toHaveBeenCalledTimes(2);
  });

  it('lets a signer cancel and refuses signatures after expiry', async () => {
    const { service, tick } = setup();
    await service.createPending(joinInput(), ANCHOR.address);
    tick(3_600_001);
    await expect(
      service.addSignature(TX, joinerSignature(), JOINER.address)
    ).rejects.toThrow('expired');
    const fresh = setup();
    await fresh.service.createPending(joinInput(), ANCHOR.address);
    await expect(
      fresh.service.cancel(TX, STRANGER.address)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await fresh.service.cancel(TX, JOINER.address)).status).toBe(
      'CANCELLED'
    );
  });

  it('stops a withdrawn join at once: its signatures go, and nothing more is taken or sent', async () => {
    const { service, gateway, db } = setup();
    await service.createPending(joinInput(), ANCHOR.address);
    const cancelled = await service.cancel(TX, ANCHOR.address);
    expect(cancelled.status).toBe('CANCELLED');
    // Gone from the row, not just hidden; when each signed is kept.
    expect(db.ops.get(TX)!.signers).toEqual([
      expect.objectContaining({ role: 0, sig: null, signed_at: 1_000_000 }),
      expect.objectContaining({ role: 4, sig: null, signed_at: null })
    ]);
    await expect(
      service.addSignature(TX, joinerSignature(), JOINER.address)
    ).rejects.toThrow('The operation is cancelled');
    await expect(
      service.createPending(bothSigned(), JOINER.address)
    ).rejects.toThrow('The operation is cancelled');
    await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
      'The operation is cancelled'
    );
    await expect(service.cancel(TX, ANCHOR.address)).rejects.toThrow(
      'The operation is cancelled'
    );
    expect(db.ops.get(TX)!.signers.every((it) => it.sig === null)).toBe(true);
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(await service.awaiting(JOINER.address)).toEqual([]);
  });

  it('never sends a join withdrawn while it is being completed, wherever the cancel lands', async () => {
    let points = 0;
    for (let at = 1; ; at++) {
      const { service, gateway, db } = setup();
      await service.createPending(joinInput(), ANCHOR.address);
      let reads = 0;
      let cancel: Promise<unknown> | null = null;
      // The identity's wallet withdraws the join just after the at-th read
      // of it, while the joining wallet's signature completes it.
      db.onFind = () => {
        if (++reads === at && !cancel) {
          cancel = service.cancel(TX, ANCHOR.address).then(
            () => 'cancelled',
            (e: unknown) => e
          );
        }
      };
      await service
        .addSignature(TX, joinerSignature(), JOINER.address)
        .catch((e: unknown) => e);
      if (!cancel) break;
      const cancelled = await cancel;
      db.onFind = null;
      points++;
      const op = db.ops.get(TX)!;
      if (gateway.submit.mock.calls.length) {
        // Sent: the cancel was refused and it shows as sent.
        expect(gateway.submit).toHaveBeenCalledTimes(1);
        expect(cancelled).toBeInstanceOf(BadRequestException);
        expect(op.status).toBe('SUBMITTED');
      } else {
        // Withdrawn: nothing went out and its signatures are gone.
        expect(cancelled).toBe('cancelled');
        expect(op.status).toBe('CANCELLED');
        expect(op.signers.every((it) => it.sig === null)).toBe(true);
      }
    }
    expect(points).toBeGreaterThanOrEqual(3);
  });

  it('refuses a cancel while the join is being sent, and shows it sent', async () => {
    const { service, gateway, db } = setup();
    await service.createPending(joinInput(), ANCHOR.address);
    let cancelled: unknown = null;
    gateway.submit.mockImplementationOnce(async () => {
      cancelled = await service
        .cancel(TX, ANCHOR.address)
        .catch((e: unknown) => e);
      return { txId: TX, accepted: true };
    });
    const op = await service.addSignature(
      TX,
      joinerSignature(),
      JOINER.address
    );
    expect(cancelled).toBeInstanceOf(BadRequestException);
    expect((cancelled as Error).message).toBe('The operation is submitted');
    expect(op.status).toBe('SUBMITTED');
    expect(db.ops.get(TX)!.status).toBe('SUBMITTED');
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });
});

describe('maySeeSignatures', () => {
  const op = (status: PendingStatus, expires_at = 2_000): PendingOperation => ({
    tx_id: TX,
    op_type: 'IDENTITY_JOIN',
    principal: null,
    unsigned_hex: '0x0102',
    typed_data_json: '{}',
    created_by: addr(ANCHOR),
    expires_at,
    status,
    result_json: null,
    last_error: null,
    created_at: 1_000,
    updated_at: 1_000,
    signers: [
      {
        role: 0,
        key_type: 1,
        signer: addr(ANCHOR),
        sig: sign(ANCHOR),
        signed_at: 1_000
      },
      { role: 4, key_type: 1, signer: addr(JOINER), sig: null, signed_at: null }
    ]
  });

  it('shows them to the operation own signers while it is pending', () => {
    expect(maySeeSignatures(op('PENDING'), ANCHOR.address, 1_500)).toBe(true);
    expect(maySeeSignatures(op('PENDING'), JOINER.address, 1_500)).toBe(true);
    expect(
      maySeeSignatures(op('PENDING'), JOINER.address.toUpperCase(), 1_500)
    ).toBe(true);
    expect(maySeeSignatures(op('PENDING'), STRANGER.address, 1_500)).toBe(
      false
    );
    for (const status of ['SUBMITTED', 'FAILED', 'CANCELLED'] as const) {
      expect(maySeeSignatures(op(status), ANCHOR.address, 1_500)).toBe(false);
    }
    expect(maySeeSignatures(op('PENDING'), ANCHOR.address, 2_000)).toBe(false);
  });
});

describe('submitFailure', () => {
  it('tells a refusal, an unknown outcome and a submit not taken apart', () => {
    const of = (code: string, status: number | null, message = 'x') =>
      submitFailure(
        new ChainGatewayError(message, status, code, '/v1/submit'),
        TX
      ).outcome;
    expect(of('inadmissible', 422)).toBe('refused');
    expect(of('bad_body', 400)).toBe('refused');
    expect(of('outcome_unknown', 504)).toBe('unknown');
    expect(of('outcome_unknown', null)).toBe('unknown');
    expect(of('bad_answer', 200, `the node took ${OTHER_TX}, not ${TX}`)).toBe(
      'unknown'
    );
    expect(of('http_503', 503)).toBe('not_taken');
    expect(of('rate_limited', 429)).toBe('not_taken');
    expect(of('network', null)).toBe('not_taken');
    expect(of('unauthorized', 401)).toBe('not_taken');
    expect(submitFailure(new TypeError('boom'), TX).outcome).toBe('unknown');
  });
});

describe('ChainRelayService.submit', () => {
  const failureOf = async (
    service: ChainRelayService,
    request: Parameters<ChainRelayService['submit']>[0]
  ) => {
    const error = await service.submit(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CustomApiCompliantException);
    const answer = error as CustomApiCompliantException;
    return {
      status: answer.getStatusCode(),
      code: answer.code,
      details: answer.details
    };
  };

  it('relays a signed operation, in either form, with its txId', async () => {
    const { service, gateway } = setup();
    expect(await service.submit({ signed: '0xabcd', txId: TX })).toEqual({
      txId: TX,
      accepted: true
    });
    expect(gateway.submit).toHaveBeenLastCalledWith({
      signed: '0xabcd',
      txId: TX
    });
    const signatures = [{ role: 0, keyType: 1, sig: sign(ANCHOR) }];
    await service.submit({
      unsigned: '0x0102',
      signatures,
      txId: TX.toUpperCase().replace('0X', '0x')
    });
    expect(gateway.submit).toHaveBeenLastCalledWith({
      unsigned: '0x0102',
      signatures,
      txId: TX
    });
  });

  it('sends nothing without the txId', async () => {
    const { service, gateway } = setup();
    for (const txId of [undefined, '', '0x12', TX + '00']) {
      await expect(
        service.submit({ signed: '0xabcd', txId } as never)
      ).rejects.toThrow('tx_id must be 32 bytes of 0x hex');
    }
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('answers the chain refusing it, the chain being away and an unknown outcome apart', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError('no', 422, 'inadmissible', '/v1/submit')
    );
    expect(await failureOf(service, { signed: '0xabcd', txId: TX })).toEqual({
      status: 422,
      code: 'CHAIN_REFUSED',
      details: { tx_id: TX, outcome: 'refused' }
    });
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError('down', null, 'network', '/v1/submit')
    );
    expect(await failureOf(service, { signed: '0xabcd', txId: TX })).toEqual({
      status: 502,
      code: 'CHAIN_UNAVAILABLE',
      details: { tx_id: TX, outcome: 'not_taken' }
    });
    gateway.submit.mockRejectedValueOnce(outcomeUnknown());
    expect(await failureOf(service, { signed: '0xabcd', txId: TX })).toEqual({
      status: 502,
      code: 'CHAIN_OUTCOME_UNKNOWN',
      details: { tx_id: TX, outcome: 'unknown' }
    });
    gateway.submit.mockRejectedValueOnce(outcomeUnknown(OTHER_TX));
    expect(await failureOf(service, { signed: '0xabcd', txId: TX })).toEqual({
      status: 502,
      code: 'CHAIN_OUTCOME_UNKNOWN',
      details: { tx_id: TX, outcome: 'unknown', node_tx_id: OTHER_TX }
    });
    await expect(
      service.submit({ signed: 'nothex', txId: TX })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
