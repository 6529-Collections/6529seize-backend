import { Wallet } from 'ethers';
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
  joinTermsOf,
  PendingOperationInput,
  submitFailure,
  typedDataDigest,
  walletSignerOf
} from './chain-relay.service';
import { join, JOIN_PRINCIPAL } from './identity-join.fixtures';

const ANCHOR = new Wallet('0x' + '11'.repeat(32));
const JOINER = new Wallet('0x' + '22'.repeat(32));
const STRANGER = new Wallet('0x' + '33'.repeat(32));
const START = 1_000_000;
const EXPIRES = START + 3_600_000;
/** The join every test holds: the anchor's identity, the joiner joining it. */
const JOIN = join({
  signer: ANCHOR.address,
  joiner: JOINER.address,
  expiresAt: EXPIRES
});
const TX = JOIN.txId;
const OTHER_TX = '0x' + 'cd'.repeat(32);
const sign = JOIN.sign;
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
    if (this.ops.has(op.tx_id)) {
      throw Object.assign(new Error('Duplicate entry'), {
        code: 'ER_DUP_ENTRY'
      });
    }
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
    submit: jest.fn(async (_request: unknown) => ({
      txId: TX,
      accepted: true
    })),
    getTx: jest.fn(async (_txId: string): Promise<unknown> => {
      throw notHeld();
    })
  };
  let now = START;
  const service = new ChainRelayService(
    gateway as never,
    db as unknown as ChainPendingOperationsDb,
    () => now,
    50
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
    principal: JOIN_PRINCIPAL,
    unsigned: '0x0102',
    typedData: JOIN.typedData,
    expiresAt: EXPIRES,
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

function notHeld() {
  return new ChainGatewayError(
    "/v1/tx: not_held: neither a block on this node's chain nor its pool holds that transaction",
    404,
    'not_held',
    '/v1/tx'
  );
}

const resultOf = (op: PendingOperation) => JSON.parse(op.result_json!);

describe('typedDataDigest', () => {
  it('is the EIP-712 digest a wallet signs', () => {
    expect(typedDataDigest(JOIN.typedData)).toBe(TX);
    expect(
      typedDataDigest(
        join({ signer: ANCHOR.address, joiner: JOINER.address, expiresAt: 1 })
          .typedData
      )
    ).not.toBe(TX);
    expect(typedDataDigest({ ...JOIN.typedData, types: {} })).toBeNull();
    // A primaryType that isn't the struct the types sign.
    expect(
      typedDataDigest({ ...JOIN.typedData, primaryType: 'TxHeader' })
    ).toBeNull();
    const wrapped = {
      ...JOIN.typedData,
      types: {
        ...JOIN.typedData.types,
        Wrapper: [{ name: 'inner', type: 'IdentityJoin' }]
      },
      message: { ...JOIN.typedData.message, inner: JOIN.typedData.message }
    };
    expect(typedDataDigest(wrapped)).toBeNull();
  });
});

describe('walletSignerOf', () => {
  it('recovers the wallet that signed the digest', () => {
    expect(walletSignerOf(TX, sign(JOINER))).toBe(addr(JOINER));
    expect(walletSignerOf(TX, '0x' + '00'.repeat(65))).toBeNull();
  });
});

describe('joinTermsOf', () => {
  it('reads what an identity join signs, as the node drafts it', () => {
    expect(joinTermsOf(JOIN.typedData)).toEqual({
      principal: JOIN_PRINCIPAL,
      signer: addr(ANCHOR),
      joiner: addr(JOINER),
      expiresAt: EXPIRES
    });
  });

  it('reads no join from anything else', () => {
    const typed = JOIN.typedData;
    const header = (typed.message as { header: Record<string, unknown> })
      .header;
    const withHeader = (changes: Record<string, unknown>) => ({
      ...typed,
      message: { ...typed.message, header: { ...header, ...changes } }
    });
    for (const other of [
      { ...typed, primaryType: 'BalanceTransfer' },
      {
        ...typed,
        types: {
          ...typed.types,
          IdentityJoinBody: [{ name: 'wallet', type: 'bytes32' }]
        }
      },
      withHeader({ keyType: 2 }),
      withHeader({ keyId: '0x' + '11'.repeat(32) }),
      withHeader({ principal: '0x' + '00'.repeat(32) }),
      withHeader({ expiresAt: 'soon' })
    ]) {
      expect(joinTermsOf(other)).toBeNull();
    }
  });
});

describe('ChainRelayService pending operations', () => {
  it('holds a join until the joining wallet signs, then relays it with its txId', async () => {
    const { service, gateway } = setup();
    const created = await service.createPending(joinInput(), ANCHOR.address);
    expect(created).toMatchObject({
      status: 'PENDING',
      op_type: 'IDENTITY_JOIN',
      principal: JOIN_PRINCIPAL,
      expires_at: EXPIRES
    });
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
    expect(resultOf(done)).toEqual({
      txId: TX,
      accepted: true,
      outcome: 'accepted'
    });
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
    const op = await service.createPending(
      { ...bothSigned(), opType: 271 },
      JOINER.address
    );
    expect(op.status).toBe('SUBMITTED');
    expect(op.op_type).toBe('IDENTITY_JOIN');
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    expect(gateway.submit.mock.calls[0][0]).toMatchObject({ txId: TX });
  });

  it('holds only identity joins', async () => {
    const { service, db } = setup();
    for (const opType of ['BALANCE_TRANSFER', 0x0201, 'IDENTITY_REMOVE']) {
      await expect(
        service.createPending({ ...joinInput(), opType }, ANCHOR.address)
      ).rejects.toThrow('Only identity joins');
    }
    // Typed data of another operation, whatever op_type says.
    const {
      IdentityJoin: _join,
      IdentityJoinBody,
      ...types
    } = JOIN.typedData.types;
    const typedData = {
      ...JOIN.typedData,
      primaryType: 'IdentityRemove',
      types: {
        ...types,
        IdentityRemove: [
          { name: 'header', type: 'TxHeader' },
          { name: 'body', type: 'IdentityRemoveBody' }
        ],
        IdentityRemoveBody: IdentityJoinBody
      }
    };
    expect(typedDataDigest(typedData)).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(
      service.createPending(
        { ...joinInput(), typedData, txId: typedDataDigest(typedData)! },
        ANCHOR.address
      )
    ).rejects.toThrow("typed_data is not an identity join's");
    expect(db.ops.size).toBe(0);
  });

  it('holds a join only as its typed data says: its signers, principal and expiry', async () => {
    const { service, db } = setup();
    const refused = (input: PendingOperationInput, wallet = ANCHOR.address) =>
      expect(service.createPending(input, wallet)).rejects.toBeInstanceOf(
        BadRequestException
      );
    // Another joining wallet than the typed data's: it never shows in that
    // wallet's list.
    await refused({
      ...joinInput(),
      required: [
        { role: 0, keyType: 1, signer: ANCHOR.address },
        { role: 4, keyType: 1, signer: STRANGER.address }
      ]
    });
    // The roles swapped, a third signer, or the joiner alone.
    await refused({
      ...joinInput(),
      required: [
        { role: 0, keyType: 1, signer: JOINER.address },
        { role: 4, keyType: 1, signer: ANCHOR.address }
      ]
    });
    await refused({
      ...joinInput(),
      required: [
        ...joinInput().required,
        { role: 1, keyType: 1, signer: STRANGER.address }
      ]
    });
    await refused({
      ...joinInput(),
      required: [{ role: 4, keyType: 1, signer: JOINER.address }]
    });
    await refused({ ...joinInput(), principal: '0x' + 'ee'.repeat(32) });
    await refused({ ...joinInput(), principal: null });
    await refused({ ...joinInput(), expiresAt: EXPIRES + 1 });
    expect(db.ops.size).toBe(0);
    // A stranger signing a join that names it nowhere.
    await expect(
      service.createPending(
        joinInput([{ role: 0, keyType: 1, sig: sign(STRANGER) }]),
        STRANGER.address
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
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

  it('refuses expired, malformed and oversized input', async () => {
    const { service } = setup();
    const late = join({
      signer: ANCHOR.address,
      joiner: JOINER.address,
      expiresAt: START + 8 * 24 * 3_600_000
    });
    const past = join({
      signer: ANCHOR.address,
      joiner: JOINER.address,
      expiresAt: START - 1
    });
    for (const input of [
      {
        ...joinInput(),
        txId: late.txId,
        typedData: late.typedData,
        expiresAt: START + 8 * 24 * 3_600_000
      },
      {
        ...joinInput(),
        txId: past.txId,
        typedData: past.typedData,
        expiresAt: START - 1
      },
      { ...joinInput(), txId: '0x12' },
      { ...joinInput(), typedData: late.typedData },
      { ...joinInput(), unsigned: '0xabc' }
    ]) {
      await expect(
        service.createPending(input, ANCHOR.address)
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('holds both wallets first posts at once as one join', async () => {
    const { service, gateway, db } = setup();
    // The joining wallet's post finds no row, as the identity's wallet's
    // insert lands: its own insert then loses on the key.
    await service.createPending(joinInput(), ANCHOR.address);
    const find = db.find.bind(db);
    db.find = jest
      .fn()
      .mockImplementationOnce(async () => null)
      .mockImplementation(find);
    const op = await service.createPending(
      joinInput([joinerSignature()]),
      JOINER.address
    );
    expect(op.status).toBe('SUBMITTED');
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('tries a lost insert once more, and nothing else', async () => {
    const { service, db } = setup();
    db.insert = jest.fn(async () => {
      throw Object.assign(new Error('Deadlock found'), {
        code: 'ER_LOCK_DEADLOCK'
      });
    });
    await expect(
      service.createPending(joinInput(), ANCHOR.address)
    ).rejects.toThrow('Deadlock found');
    expect(db.insert).toHaveBeenCalledTimes(2);
    db.insert = jest.fn(async () => {
      throw Object.assign(new Error('bad sql'), { code: 'ER_PARSE_ERROR' });
    });
    await expect(
      service.createPending(joinInput(), ANCHOR.address)
    ).rejects.toThrow('bad sql');
    expect(db.insert).toHaveBeenCalledTimes(1);
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

  it('keeps it pending when the request never reached the node, or the gateway refused this backend', async () => {
    const unauthorized = new ChainGatewayError(
      'bad key',
      401,
      'unauthorized',
      '/v1/submit'
    );
    unauthorized.txId = TX;
    for (const error of [
      new ChainGatewayError(
        'CHAIN_GATEWAY_URL is not set',
        null,
        'not_configured',
        ''
      ),
      new ChainGatewayError('Not a transaction id: x', null, 'bad_request', ''),
      unauthorized
    ]) {
      const { service, gateway } = setup();
      gateway.submit.mockRejectedValueOnce(error);
      const op = await service.createPending(bothSigned(), ANCHOR.address);
      expect(op.status).toBe('PENDING');
      expect(op.result_json).toBeNull();
      expect((await service.retry(TX, ANCHOR.address)).status).toBe(
        'SUBMITTED'
      );
    }
  });

  it('marks an operation the chain refuses as failed', async () => {
    for (const error of [
      new ChainGatewayError(
        '0x2101 ALREADY_BOUND',
        422,
        'inadmissible',
        '/v1/submit'
      ),
      new ChainGatewayError('malformed', 400, 'bad_request', '/v1/submit')
    ]) {
      const { service, gateway } = setup();
      gateway.submit.mockRejectedValueOnce(error);
      const op = await service.createPending(bothSigned(), ANCHOR.address);
      expect(op.status).toBe('FAILED');
      expect(op.last_error).toBe(error.message);
      expect(resultOf(op)).toEqual({
        txId: TX,
        outcome: 'refused',
        code: error.code
      });
      await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
        'The operation is failed'
      );
    }
  });

  it('never sends a join again once its outcome is unknown', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(outcomeUnknown());
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    expect(op.status).toBe('SUBMITTED');
    expect(resultOf(op)).toEqual({ txId: TX, outcome: 'unknown' });
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
    const { service, gateway } = setup();
    const error = outcomeUnknown(OTHER_TX);
    error.message = `/v1/submit: the outcome is unknown (bad_answer): ask getTx for ${OTHER_TX}`;
    gateway.submit.mockRejectedValueOnce(error);
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    expect(op.status).toBe('SUBMITTED');
    expect(resultOf(op)).toEqual({
      txId: TX,
      outcome: 'unknown',
      nodeTxId: OTHER_TX
    });
    expect(op.last_error).toContain(`took ${OTHER_TX}, not ${TX}`);
    await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
      'submitted'
    );
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it('records the node taking it even when it cannot write that down', async () => {
    const { service, gateway, db } = setup();
    const setStatus = db.setStatus.bind(db);
    db.setStatus = jest.fn(
      async (
        txId: string,
        change: { from: PendingStatus; to: PendingStatus },
        fields: { result_json?: string | null; last_error?: string | null },
        now: number
      ) => {
        if (change.from === 'SUBMITTED' && change.to === 'SUBMITTED') {
          throw new Error('the database went away');
        }
        return setStatus(txId, change, fields, now);
      }
    );
    const op = await service.createPending(bothSigned(), ANCHOR.address);
    // Not recorded as a failed send: still the claim's unknown outcome,
    // with no error of its own, for a read to settle from the chain.
    expect(op.status).toBe('SUBMITTED');
    expect(resultOf(op)).toEqual({ txId: TX, outcome: 'unknown' });
    expect(op.last_error).toBeNull();
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    db.setStatus = setStatus;
    gateway.getTx.mockResolvedValueOnce({ txId: TX, status: 'pending' });
    const settled = await service.get(TX);
    expect(resultOf(settled)).toMatchObject({ outcome: 'accepted' });
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
      expect.objectContaining({ role: 0, sig: null, signed_at: START }),
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

describe('ChainRelayService.get, of a join sent with an unknown outcome', () => {
  async function unknownJoin(error = outcomeUnknown()) {
    const it = setup();
    it.gateway.submit.mockRejectedValueOnce(error);
    await it.service.createPending(bothSigned(), ANCHOR.address);
    return it;
  }

  it('records what the chain holds', async () => {
    const { service, gateway } = await unknownJoin();
    const tx = { txId: TX, status: 'final', height: 12, block: '0xb' };
    gateway.getTx.mockResolvedValueOnce(tx);
    const op = await service.get(TX);
    expect(gateway.getTx).toHaveBeenCalledWith(TX);
    expect(op.status).toBe('SUBMITTED');
    expect(resultOf(op)).toEqual({ txId: TX, outcome: 'accepted', tx });
    expect(op.last_error).toBeNull();
    // Settled: no more asking.
    await service.get(TX);
    expect(gateway.getTx).toHaveBeenCalledTimes(1);
  });

  it('records the other transaction the node named, when the chain holds it', async () => {
    const { service, gateway } = await unknownJoin(outcomeUnknown(OTHER_TX));
    const tx = { txId: OTHER_TX, status: 'in_block', height: 12 };
    gateway.getTx.mockImplementation(async (txId: string) => {
      if (txId === OTHER_TX) return tx;
      throw notHeld();
    });
    const op = await service.get(TX);
    expect(resultOf(op)).toEqual({
      txId: TX,
      outcome: 'accepted',
      nodeTxId: OTHER_TX,
      tx
    });
  });

  it('keeps it unknown while it may still land, or the chain cannot say', async () => {
    const { service, gateway, tick } = await unknownJoin();
    expect(resultOf(await service.get(TX)).outcome).toBe('unknown');
    // Expired, but not long enough for the blocks before it to arrive.
    tick(3_600_000 + 60_000);
    expect((await service.get(TX)).status).toBe('SUBMITTED');
    // Long expired, but the chain doesn't answer: in time, or at all.
    tick(10 * 60_000);
    gateway.getTx.mockImplementationOnce(() => new Promise(() => undefined));
    const started = Date.now();
    expect(resultOf(await service.get(TX)).outcome).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2_000);
    gateway.getTx.mockRejectedValueOnce(
      new ChainGatewayError('down', null, 'network', '/v1/tx')
    );
    expect(resultOf(await service.get(TX)).outcome).toBe('unknown');
  });

  it('fails it once it has expired and the chain never held it', async () => {
    const { service, tick } = await unknownJoin();
    tick(3_600_000 + 6 * 60_000);
    const op = await service.get(TX);
    expect(op.status).toBe('FAILED');
    expect(resultOf(op)).toEqual({
      txId: TX,
      outcome: 'refused',
      code: 'expired'
    });
    expect(op.last_error).toContain('never took');
  });
});

describe('submitFailure', () => {
  it('tells a refusal, an unknown outcome and a submit not taken apart', () => {
    const of = (code: string, status: number | null) =>
      submitFailure(new ChainGatewayError('x', status, code, '/v1/submit'), TX)
        .outcome;
    expect(of('inadmissible', 422)).toBe('refused');
    expect(of('bad_body', 400)).toBe('refused');
    expect(of('bad_request', 400)).toBe('refused');
    expect(of('outcome_unknown', 504)).toBe('unknown');
    expect(of('outcome_unknown', null)).toBe('unknown');
    expect(of('http_503', 503)).toBe('not_taken');
    expect(of('rate_limited', 429)).toBe('not_taken');
    expect(of('network', null)).toBe('not_taken');
    expect(of('unauthorized', 401)).toBe('not_taken');
    expect(of('not_configured', null)).toBe('not_taken');
    expect(of('bad_request', null)).toBe('not_taken');
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
      accepted: true,
      outcome: 'accepted'
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
