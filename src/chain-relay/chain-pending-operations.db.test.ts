import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ChainPendingOperationsDb } from './chain-pending-operations.db';

const TX = '0x' + '5a'.repeat(32);
const A = '0x' + '01'.repeat(20);
const B = '0x' + '02'.repeat(20);
const db = new ChainPendingOperationsDb(() => sqlExecutor);

describeWithSeed('ChainPendingOperationsDb', [], () => {
  it('stores an operation, its signatures and its status', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.insert(
        {
          tx_id: TX,
          op_type: 'IDENTITY_JOIN',
          principal: '0x' + 'ab'.repeat(32),
          unsigned_hex: '0x0102',
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
        },
        conn
      )
    );
    expect(await db.awaiting(B, 2_000)).toEqual([TX]);
    expect(await db.awaiting(A, 2_000)).toEqual([]);
    expect(await db.awaiting(B, 6_000)).toEqual([]);

    await sqlExecutor.executeNativeQueriesInTransaction((conn) =>
      db.setSignature(TX, 4, '0x' + 'bb'.repeat(65), 2_500, conn)
    );
    await db.setStatus(
      TX,
      'SUBMITTED',
      { result_json: '{"accepted":true}' },
      3_000
    );
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
});
