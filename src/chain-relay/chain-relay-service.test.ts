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
  PendingOperationInput,
  walletSignerOf
} from './chain-relay.service';

const TX = '0x' + '5a'.repeat(32);
const ANCHOR = new Wallet('0x' + '11'.repeat(32));
const JOINER = new Wallet('0x' + '22'.repeat(32));
const STRANGER = new Wallet('0x' + '33'.repeat(32));
const sign = (wallet: Wallet, txId = TX) =>
  wallet.signingKey.sign(txId).serialized;
const addr = (wallet: Wallet) => wallet.address.toLowerCase();

class FakeDb {
  ops = new Map<string, PendingOperation>();
  async executeNativeQueriesInTransaction<T>(fn: (c: unknown) => Promise<T>) {
    return fn({});
  }
  async find(txId: string) {
    const op = this.ops.get(txId);
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
  async setStatus(
    txId: string,
    status: PendingStatus,
    fields: { result_json?: string | null; last_error?: string | null },
    now: number
  ) {
    const op = this.ops.get(txId)!;
    this.ops.set(txId, {
      ...op,
      status,
      result_json: fields.result_json ?? null,
      last_error: fields.last_error ?? null,
      updated_at: now
    });
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
    submit: jest.fn(async () => ({ txId: TX, accepted: true }))
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
    expiresAt: 1_000_000 + 3_600_000,
    required: [
      { role: 0, keyType: 1, signer: ANCHOR.address },
      { role: 4, keyType: 1, signer: JOINER.address }
    ],
    signatures
  };
}

describe('walletSignerOf', () => {
  it('recovers the wallet that signed the digest', () => {
    expect(walletSignerOf(TX, sign(JOINER))).toBe(addr(JOINER));
    expect(walletSignerOf(TX, '0x' + '00'.repeat(65))).toBeNull();
  });
});

describe('ChainRelayService pending operations', () => {
  it('holds a join until the joining wallet signs, then relays it', async () => {
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
      { role: 4, keyType: 1, sig: sign(JOINER) },
      JOINER.address
    );
    expect(done.status).toBe('SUBMITTED');
    expect(JSON.parse(done.result_json!)).toEqual({ txId: TX, accepted: true });
    expect(gateway.submit).toHaveBeenCalledWith({
      unsigned: '0x0102',
      signatures: [
        { role: 0, keyType: 1, sig: sign(ANCHOR) },
        { role: 4, keyType: 1, sig: sign(JOINER) }
      ]
    });
    expect(await service.awaiting(JOINER.address)).toEqual([]);
  });

  it('relays at once when every signature comes with it', async () => {
    const { service, gateway } = setup();
    const op = await service.createPending(
      joinInput([
        { role: 0, keyType: 1, sig: sign(ANCHOR) },
        { role: 4, keyType: 1, sig: sign(JOINER) }
      ]),
      JOINER.address
    );
    expect(op.status).toBe('SUBMITTED');
    expect(gateway.submit).toHaveBeenCalledTimes(1);
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
      service.addSignature(
        TX,
        { role: 4, keyType: 1, sig: sign(JOINER) },
        STRANGER.address
      )
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
    for (const input of [
      { ...joinInput(), expiresAt: 999_999 },
      { ...joinInput(), expiresAt: 1_000_000 + 8 * 24 * 3_600_000 },
      { ...joinInput(), txId: '0x12' },
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
    const op = await service.createPending(
      joinInput([
        { role: 0, keyType: 1, sig: sign(ANCHOR) },
        { role: 4, keyType: 1, sig: sign(JOINER) }
      ]),
      ANCHOR.address
    );
    expect(op.status).toBe('PENDING');
    expect(op.last_error).toContain('busy');
    expect((await service.retry(TX, JOINER.address)).status).toBe('SUBMITTED');
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
    const op = await service.createPending(
      joinInput([
        { role: 0, keyType: 1, sig: sign(ANCHOR) },
        { role: 4, keyType: 1, sig: sign(JOINER) }
      ]),
      ANCHOR.address
    );
    expect(op.status).toBe('FAILED');
    expect(op.last_error).toContain('ALREADY_BOUND');
    await expect(service.retry(TX, ANCHOR.address)).rejects.toThrow(
      'The operation is failed'
    );
  });

  it('lets a signer cancel and refuses signatures after expiry', async () => {
    const { service, tick } = setup();
    await service.createPending(joinInput(), ANCHOR.address);
    tick(3_600_001);
    await expect(
      service.addSignature(
        TX,
        { role: 4, keyType: 1, sig: sign(JOINER) },
        JOINER.address
      )
    ).rejects.toThrow('expired');
    const fresh = setup();
    await fresh.service.createPending(joinInput(), ANCHOR.address);
    expect((await fresh.service.cancel(TX, JOINER.address)).status).toBe(
      'CANCELLED'
    );
    await expect(
      fresh.service.cancel(TX, STRANGER.address)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ChainRelayService.submit', () => {
  it('relays a signed operation', async () => {
    const { service, gateway } = setup();
    expect(await service.submit({ signed: '0xabcd' })).toEqual({
      txId: TX,
      accepted: true
    });
    expect(gateway.submit).toHaveBeenCalledWith({ signed: '0xabcd' });
  });

  it('answers the chain refusing it, and the chain being away', async () => {
    const { service, gateway } = setup();
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError('no', 422, 'inadmissible', '/v1/submit')
    );
    const refused = await service
      .submit({ signed: '0xabcd' })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CustomApiCompliantException);
    expect(refused).toMatchObject({ code: 'CHAIN_REFUSED' });
    expect((refused as CustomApiCompliantException).getStatusCode()).toBe(422);
    gateway.submit.mockRejectedValueOnce(
      new ChainGatewayError('down', null, 'network', '/v1/submit')
    );
    const away = await service.submit({ signed: '0xabcd' }).catch((e) => e);
    expect((away as CustomApiCompliantException).getStatusCode()).toBe(502);
    await expect(service.submit({ signed: 'nothex' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});
