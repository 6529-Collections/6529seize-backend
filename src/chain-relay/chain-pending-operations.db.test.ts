import 'reflect-metadata';
import { Wallet } from 'ethers';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  ChainPendingOperationsDb,
  PendingOperation
} from './chain-pending-operations.db';
import { ChainRelayService } from './chain-relay.service';
import { join as joinFixture, JOIN_PRINCIPAL } from './identity-join.fixtures';

const TX = '0x' + '5a'.repeat(32);
const TX2 = '0x' + '5b'.repeat(32);
const TX3 = '0x' + '5c'.repeat(32);
const A = '0x' + '01'.repeat(20);
const B = '0x' + '02'.repeat(20);
const db = new ChainPendingOperationsDb(() => sqlExecutor);

function join(txId = TX): PendingOperation {
  return {
    tx_id: txId,
    op_type: 'IDENTITY_JOIN',
    principal: '0x' + 'ab'.repeat(32),
    unsigned_hex: '0x0102',
    typed_data_json: '{"primaryType":"IdentityJoin"}',
    created_by: A,
    expires_at: 5_000,
    status: 'PENDING',
    result_json: null,
    last_error: null,
    created_at: 1_000,
    updated_at: 1_000,
    signers: [
      {
        role: 0,
        key_type: 1,
        signer: A,
        sig: '0x' + 'aa'.repeat(65),
        signed_at: 1_000
      },
      { role: 4, key_type: 1, signer: B, sig: null, signed_at: null }
    ]
  };
}

/**
 * Resolves once the transaction on the connection `threadOf()` names is
 * blocked waiting for a row lock: the database's own state, not a sleep.
 */
async function untilWaitingForALock(
  threadOf: () => number | undefined
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const threadId = threadOf();
    const trx =
      threadId === undefined
        ? null
        : await sqlExecutor.oneOrNull<{ trx_state: string }>(
            `select trx_state from information_schema.innodb_trx
             where trx_mysql_thread_id = :threadId`,
            { threadId }
          );
    if (trx?.trx_state === 'LOCK WAIT') return;
    if (Date.now() > deadline) {
      throw new Error(
        `The cancel never waited for the claim's lock: ${JSON.stringify(trx)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeWithSeed('ChainPendingOperationsDb', [], () => {
  it('stores an operation, its signatures and its status', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.insert(join(), conn)
    );
    expect((await db.awaiting(B, 2_000)).map((it) => it.tx_id)).toEqual([TX]);
    expect(await db.awaiting(A, 2_000)).toEqual([]);
    expect(await db.awaiting(B, 6_000)).toEqual([]);

    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.setSignature(TX, 4, '0x' + 'bb'.repeat(65), 2_500, conn)
    );
    expect(
      await db.setStatus(
        TX,
        { from: 'PENDING', to: 'SUBMITTED' },
        { result_json: '{"accepted":true}' },
        3_000
      )
    ).toBe(true);
    const op = await db.find(TX);
    expect(op).toEqual(
      expect.objectContaining({
        tx_id: TX,
        status: 'SUBMITTED',
        result_json: '{"accepted":true}',
        expires_at: 5_000,
        updated_at: 3_000
      })
    );
    expect(op?.signers).toEqual([
      {
        role: 0,
        key_type: 1,
        signer: A,
        sig: '0x' + 'aa'.repeat(65),
        signed_at: 1_000
      },
      {
        role: 4,
        key_type: 1,
        signer: B,
        sig: '0x' + 'bb'.repeat(65),
        signed_at: 2_500
      }
    ]);
    expect(await db.awaiting(B, 2_000)).toEqual([]);
  });

  it('lists the joins waiting for a wallet in one query, with their signers and what they sign', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (conn) => {
      await db.insert(join(), conn);
      await db.insert({ ...join(TX2), created_at: 1_500 }, conn);
      await db.insert({ ...join(TX3), status: 'CANCELLED' }, conn);
    });
    const listed = await db.awaiting(B, 2_000);
    expect(listed.map((it) => it.tx_id)).toEqual([TX2, TX]);
    expect(listed[1]).toEqual(
      expect.objectContaining({
        tx_id: TX,
        unsigned_hex: '0x0102',
        typed_data_json: '{"primaryType":"IdentityJoin"}',
        created_by: A,
        expires_at: 5_000,
        status: 'PENDING',
        created_at: 1_000
      })
    );
    expect(listed[1].signers).toEqual(join().signers);
  });

  it("counts a wallet's pending, unexpired joins", async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (conn) => {
      await db.insert(join(), conn);
      await db.insert(join(TX2), conn);
      await db.insert({ ...join(TX3), status: 'CANCELLED' }, conn);
    });
    const count = (wallet: string, now: number) =>
      sqlExecutor.executeNativeQueriesInTransaction((conn) =>
        db.countOpenCreatedBy(wallet, now, conn)
      );
    expect(await count(A, 2_000)).toBe(2);
    expect(await count(B, 2_000)).toBe(0);
    expect(await count(A, 6_000)).toBe(0);
  });

  it("moves a status only while the result's outcome is the one given", async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.insert(
        {
          ...join(),
          status: 'SUBMITTED',
          result_json: JSON.stringify({ txId: TX, outcome: 'accepted' })
        },
        conn
      )
    );
    expect(
      await db.setStatus(
        TX,
        { from: 'SUBMITTED', to: 'FAILED', ifOutcome: 'unknown' },
        { result_json: '{"outcome":"refused"}' },
        2_000
      )
    ).toBe(false);
    expect((await db.find(TX))?.status).toBe('SUBMITTED');
    expect(
      await db.setStatus(
        TX,
        { from: 'SUBMITTED', to: 'SUBMITTED', ifOutcome: 'accepted' },
        { result_json: '{"outcome":"accepted","checkedAt":2000}' },
        2_000
      )
    ).toBe(true);
    expect((await db.find(TX))?.result_json).toBe(
      '{"outcome":"accepted","checkedAt":2000}'
    );
  });

  it('moves a status only from the one given, and drops signatures but not when they were given', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.insert(join(), conn)
    );
    expect(
      await db.setStatus(TX, { from: 'SUBMITTED', to: 'FAILED' }, {}, 2_000)
    ).toBe(false);
    expect((await db.find(TX))?.status).toBe('PENDING');
    await sqlExecutor.executeNativeQueriesInTransaction(async (conn) => {
      expect(
        await db.setStatus(
          TX,
          { from: 'PENDING', to: 'CANCELLED' },
          {},
          2_000,
          conn
        )
      ).toBe(true);
      await db.clearSignatures(TX, conn);
    });
    const op = await db.find(TX);
    expect(op?.status).toBe('CANCELLED');
    expect(op?.signers.map((it) => [it.role, it.sig, it.signed_at])).toEqual([
      [0, null, 1_000],
      [4, null, null]
    ]);
    expect(
      await db.setStatus(TX, { from: 'PENDING', to: 'SUBMITTED' }, {}, 3_000)
    ).toBe(false);
    expect((await db.find(TX))?.status).toBe('CANCELLED');
  });

  it('holds a cancel on the locked row until the claim commits, then finds it moved', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.insert(join(), conn)
    );
    let releaseClaim!: () => void;
    const claimHeld = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const claim = sqlExecutor.executeNativeQueriesInTransaction(
      async (conn) => {
        expect((await db.find(TX, conn))?.status).toBe('PENDING');
        locked();
        await claimHeld;
        return db.setStatus(
          TX,
          { from: 'PENDING', to: 'SUBMITTED' },
          {},
          2_000,
          conn
        );
      }
    );
    await rowLocked;
    let cancelSawStatus: string | undefined;
    let cancelThread: number | undefined;
    const cancel = sqlExecutor.executeNativeQueriesInTransaction(
      async (conn) => {
        cancelThread = conn.connection.threadId;
        cancelSawStatus = (await db.find(TX, conn))?.status;
        return db.setStatus(
          TX,
          { from: 'PENDING', to: 'CANCELLED' },
          {},
          2_500,
          conn
        );
      }
    );
    // The cancel waits on the row while the claim holds it.
    await untilWaitingForALock(() => cancelThread);
    expect(cancelSawStatus).toBeUndefined();
    releaseClaim();
    expect(await claim).toBe(true);
    expect(await cancel).toBe(false);
    expect(cancelSawStatus).toBe('SUBMITTED');
    expect((await db.find(TX))?.status).toBe('SUBMITTED');
  });

  it('holds two first posts of a join, sent at once, as one join sent once', async () => {
    const anchor = new Wallet('0x' + '11'.repeat(32));
    const joiner = new Wallet('0x' + '22'.repeat(32));
    const expiresAt = Date.now() + 3_600_000;
    const held = joinFixture({
      signer: anchor.address,
      joiner: joiner.address,
      expiresAt
    });
    const gateway = {
      submit: jest.fn(async () => ({ txId: held.txId, accepted: true })),
      getTx: jest.fn(),
      getOps: jest.fn(async () => ({ maxValidityMs: 86_400_000 })),
      getIdentityByWallet: jest.fn(async () => ({
        principalId: JOIN_PRINCIPAL
      }))
    };
    const relay = new ChainRelayService(gateway as never, db);
    // The identity's wallet posts it twice at once, the second time with
    // the joining wallet's signature too.
    const post = (signers: { wallet: Wallet; role: number }[]) =>
      relay.createPending(
        {
          txId: held.txId,
          opType: 'IDENTITY_JOIN',
          principal: JOIN_PRINCIPAL,
          unsigned: '0x0102',
          typedData: held.typedData,
          expiresAt,
          required: [
            { role: 0, keyType: 1, signer: anchor.address },
            { role: 4, keyType: 1, signer: joiner.address }
          ],
          signatures: signers.map(({ wallet, role }) => ({
            role,
            keyType: 1,
            sig: held.sign(wallet)
          }))
        },
        anchor.address
      );
    const both = await Promise.all([
      post([{ wallet: anchor, role: 0 }]),
      post([
        { wallet: anchor, role: 0 },
        { wallet: joiner, role: 4 }
      ])
    ]);
    expect(both.map((it) => it.tx_id)).toEqual([held.txId, held.txId]);
    const op = await db.find(held.txId);
    expect(op?.status).toBe('SUBMITTED');
    expect(op?.signers.map((it) => !!it.sig)).toEqual([true, true]);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });
});
