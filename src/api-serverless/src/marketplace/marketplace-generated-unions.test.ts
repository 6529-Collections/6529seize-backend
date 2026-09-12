import { ApiMarketBatchOperation } from '@/api/generated/models/ApiMarketBatchOperation';
import { ApiMarketBatchPrepareRequest } from '@/api/generated/models/ApiMarketBatchPrepareRequest';
import { ApiMarketKind } from '@/api/generated/models/ApiMarketKind';
import { ApiMarketOperation } from '@/api/generated/models/ApiMarketOperation';
import { ApiMarketPrepareRequest } from '@/api/generated/models/ApiMarketPrepareRequest';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';

const wallet = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const currency = '0x0000000000000000000000000000000000000000';
const amount = '10000000000000000001';
const order = {
  protocol_address: '0x0000000000000068f116a894984e2db1123eb395',
  order_hash: `0x${'ab'.repeat(32)}`
};
const assetKey = `1:${recipient}:94`;
const transaction = {
  chain_id: 1,
  sender: wallet,
  to: order.protocol_address,
  value: amount,
  data: '0x12345678',
  purpose: 'FULFILL'
};

function singleRequest(kind: ApiMarketKind) {
  return {
    profile_id: 'profile-id',
    wallet,
    recipient,
    asset_key: assetKey,
    kind,
    quantity: '2',
    currency,
    amount_wei: amount,
    acknowledge_external_recipient: true,
    order,
    ...(kind === ApiMarketKind.List || kind === ApiMarketKind.Offer
      ? { expires_at: 2_000_000_000 }
      : {})
  };
}

const operationEnvelope = {
  id: 'operation-id',
  revision: 2,
  state: 'REVIEW',
  profile_id: 'profile-id',
  wallet,
  currency,
  total_wei: amount,
  approval_transactions: [],
  expires_at: 2_000_000_000_000,
  updated_at: 1_999_999_990_000,
  potential_liability_wei: amount
};

function singleResult(kind: ApiMarketKind) {
  return {
    ...operationEnvelope,
    kind,
    recipient,
    recipient_in_profile: false,
    asset_key: assetKey,
    quantity: '2',
    net_wei: '10000000000000000000',
    fees: [{ recipient: wallet, amount_wei: '1' }],
    transaction
  };
}

const items = [
  {
    asset_key: assetKey,
    order,
    quantity: '2',
    amount_wei: amount,
    allocations: [
      {
        recipient: wallet,
        quantity: '1',
        acknowledge_external_recipient: false
      },
      {
        recipient,
        quantity: '1',
        acknowledge_external_recipient: true
      }
    ]
  }
];

const batchRequest = {
  kind: 'BUY_BATCH',
  profile_id: 'profile-id',
  wallet,
  currency,
  execution_policy: 'ALL_OR_REVERT',
  amount_wei: amount,
  items
};
const batchResult = {
  ...operationEnvelope,
  kind: 'BUY_BATCH',
  execution_policy: 'ALL_OR_REVERT',
  items: items.map((item) => ({
    ...item,
    net_wei: '10000000000000000000',
    fees: [{ recipient: wallet, amount_wei: '1' }],
    allocations: item.allocations.map((allocation) => ({
      ...allocation,
      recipient_in_profile: allocation.recipient === wallet
    }))
  })),
  transaction,
  mirror_terms: {
    start_time: '1999999980',
    end_time: '2000000000',
    salt: '17'
  },
  send_attempt: {
    attempt_id: '11111111-1111-4111-8111-111111111111',
    purpose: 'TRANSACTION',
    transaction_digest: 'cd'.repeat(32),
    snapshot_block: 25_000_000,
    status: 'ACTIVE',
    transaction,
    transaction_hash: null
  }
};

function roundTrip(value: object, type: string) {
  const serialized = ObjectSerializer.serialize(value, type, '');
  expect(JSON.parse(JSON.stringify(serialized))).toEqual(value);
  const deserialized = ObjectSerializer.deserialize(serialized, type, '');
  expect(JSON.parse(JSON.stringify(deserialized))).toEqual(value);
  expect(
    JSON.parse(
      JSON.stringify(ObjectSerializer.serialize(deserialized, type, ''))
    )
  ).toEqual(value);
  return deserialized;
}

describe('marketplace generated union serialization', () => {
  it.each(Object.values(ApiMarketKind))(
    'round trips the %s prepare request',
    (kind) => {
      expect(
        roundTrip(singleRequest(kind), 'ApiMarketOperationPrepareRequest')
      ).toBeInstanceOf(ApiMarketPrepareRequest);
    }
  );

  it.each(Object.values(ApiMarketKind))(
    'round trips the %s operation result',
    (kind) => {
      expect(
        roundTrip(singleResult(kind), 'ApiMarketOperationResult')
      ).toBeInstanceOf(ApiMarketOperation);
    }
  );

  it('round trips an exact batch request with separate recipient allocations', () => {
    expect(
      roundTrip(batchRequest, 'ApiMarketOperationPrepareRequest')
    ).toBeInstanceOf(ApiMarketBatchPrepareRequest);
  });

  it('round trips batch review terms and an unresolved send journal', () => {
    expect(roundTrip(batchResult, 'ApiMarketOperationResult')).toBeInstanceOf(
      ApiMarketBatchOperation
    );
  });

  it('round trips mixed single and batch history without dropping batch terms', () => {
    roundTrip(
      {
        operations: [
          ...Object.values(ApiMarketKind).map(singleResult),
          batchResult
        ],
        next: null
      },
      'ApiMarketMyOperations'
    );
  });
});
