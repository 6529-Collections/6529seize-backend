import { DELEGATIONS_IFACE } from '@/abis/delegations';
import type { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import { toNftDelegationLogRecord } from '@/delegations';

const DELEGATOR = '0xc01d000000000000000000000000000000000c01';
const SUB = '0x2222222222222222222222222222222222222222';
const DELEGATE = '0x1111111111111111111111111111111111111111';
const NEW_DELEGATE = '0x3333333333333333333333333333333333333333';
const COLLECTION = '0x33fd426905f149f8376e227d0c9d3340aad17af1';

function log(name: string, values: unknown[]): Log {
  const { data, topics } = DELEGATIONS_IFACE.encodeEventLog(name, values);
  return {
    blockNumber: 24_000_001,
    blockHash: '0x' + 'ab'.repeat(32),
    transactionIndex: 4,
    transactionHash: '0x' + 'cd'.repeat(32),
    address: '0x' + '00'.repeat(20),
    data,
    topics,
    logIndex: 7,
    removed: false
  };
}

describe('toNftDelegationLogRecord', () => {
  it('records a registration with its token scope', () => {
    expect(
      toNftDelegationLogRecord(
        log('RegisterDelegation', [
          DELEGATOR,
          COLLECTION,
          DELEGATE,
          2,
          false,
          BigInt('123456789012345678901')
        ])
      )
    ).toEqual({
      block: 24_000_001,
      log_index: 7,
      transaction_hash: '0x' + 'cd'.repeat(32),
      event_name: 'RegisterDelegation',
      delegator: DELEGATOR.toLowerCase(),
      actor: null,
      delegate: DELEGATE.toLowerCase(),
      collection: COLLECTION.toLowerCase(),
      use_case: 2,
      all_tokens: false,
      token_id: '123456789012345678901'
    });
  });

  it('records the delegator and the sender of a sub-delegated revocation', () => {
    expect(
      toNftDelegationLogRecord(
        log('RevokeDelegationUsingSubDelegation', [
          DELEGATOR,
          SUB,
          COLLECTION,
          DELEGATE,
          999
        ])
      )
    ).toEqual(
      expect.objectContaining({
        event_name: 'RevokeDelegationUsingSubDelegation',
        delegator: DELEGATOR.toLowerCase(),
        actor: SUB.toLowerCase(),
        delegate: DELEGATE.toLowerCase(),
        use_case: 999,
        all_tokens: null,
        token_id: null
      })
    );
  });

  it('records the new delegate of an update', () => {
    expect(
      toNftDelegationLogRecord(
        log('UpdateDelegation', [
          DELEGATOR,
          COLLECTION,
          DELEGATE,
          NEW_DELEGATE,
          3,
          true,
          0
        ])
      )
    ).toEqual(
      expect.objectContaining({
        event_name: 'UpdateDelegation',
        delegator: DELEGATOR.toLowerCase(),
        actor: null,
        delegate: NEW_DELEGATE.toLowerCase(),
        use_case: 3,
        all_tokens: true,
        token_id: '0'
      })
    );
  });

  it('skips a log that is not an NFTDelegation event', () => {
    const other = log('RevokeDelegation', [DELEGATOR, COLLECTION, DELEGATE, 1]);
    expect(
      toNftDelegationLogRecord({
        ...other,
        topics: ['0x' + '00'.repeat(32)]
      })
    ).toBeNull();
  });
});
