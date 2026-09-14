import { AuthenticationContext } from '@/auth-context';
import { collectingDb } from '@/collecting/collecting.db';
import {
  MarketOperationRow,
  marketOperationsDb,
  marketRequestHash
} from '@/marketplace/market-operations.db';
import {
  marketOperationRevision,
  reviewedTransactionDigest
} from '@/marketplace/market-operation-state';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { marketBatchPrepareSchema } from '@/marketplace/market-batch.schema';
import {
  marketBatchFixture,
  BATCH_BUYER,
  BATCH_OWN
} from '@/marketplace/market-batch.test-fixture';
import { buildMarketBatchTransaction } from '@/marketplace/seaport-batch.builder';
import { simulateStoredMarketBatch } from '@/marketplace/market-batch-preflight-rpc';
import { withBatchPreflightLimit } from '@/marketplace/market-batch-preflight-limit';
import { preflightMarketBatch } from './marketplace-batch-preflight';

jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readAccountHoldings: jest.fn() }
}));
jest.mock('@/marketplace/market-batch-preflight-rpc', () => ({
  simulateStoredMarketBatch: jest.fn()
}));
jest.mock('@/marketplace/market-batch-preflight-limit', () => ({
  withBatchPreflightLimit: jest.fn()
}));

const ID = '10000000-0000-4000-8000-000000000001';
const NOW = 1800000;
const SNAPSHOT = {
  block_number: 100,
  block_hash: `0x${'12'.repeat(32)}`,
  block_timestamp: 1800
};
function auth(
  wallet: string | null = BATCH_BUYER,
  profile = 'profile',
  role: string | null = null
) {
  return new AuthenticationContext({
    authenticatedWallet: wallet,
    authenticatedProfileId: profile,
    roleProfileId: role,
    activeProxyActions: []
  });
}
function fixture() {
  const f = marketBatchFixture();
  const prepared: MarketBatchPrepared = {
    intent: f.intent,
    approvalTransactions: [],
    transaction: buildMarketBatchTransaction(f.intent, f.materials, f.terms),
    gas: {
      gas_limit: '200000',
      max_fee_per_gas: '10',
      gas_reserve_wei: '2000000'
    },
    snapshot: SNAPSHOT,
    mirrorTerms: f.terms,
    validUntil: 2000000,
    feePolicyVersion: 'EXACT_SELECTED_SIGNED_ORDERS',
    reviewOrders: f.materials.map(({ order }) => ({
      protocolAddress: order.protocolAddress,
      orderHash: order.orderHash,
      digest: order.digest,
      components: order.components
    }))
  };
  const request = marketBatchPrepareSchema.parse({
    kind: 'BUY_BATCH',
    profile_id: 'profile',
    wallet: BATCH_BUYER,
    currency: f.intent.currency,
    execution_policy: 'ALL_OR_REVERT',
    amount_wei: f.intent.totalWei,
    items: f.intent.items.map((line) => ({
      asset_key: line.assetKey,
      quantity: line.intent.quantity,
      amount_wei: line.intent.maxTotalWei,
      order: {
        protocol_address: line.intent.order!.protocolAddress,
        order_hash: line.intent.order!.orderHash
      },
      allocations: line.allocations.map((a) => ({
        recipient: a.recipient,
        quantity: a.quantity,
        acknowledge_external_recipient: a.acknowledgeExternalRecipient
      }))
    }))
  });
  const row: MarketOperationRow = {
    id: ID,
    profile_id: 'profile',
    wallet: BATCH_BUYER,
    idempotency_key: ID,
    request_hash: marketRequestHash(request),
    request_json: request,
    state: 'REVIEW',
    prepared_json: prepared,
    send_attempt_json: null,
    transaction_hash: null,
    order_hash: null,
    liability_wei: '0',
    currency: request.currency,
    error_code: null,
    created_at: NOW - 1000,
    updated_at: NOW,
    expires_at: 2000000
  };
  const input = () => ({
    expected_revision: marketOperationRevision(row),
    transaction_digest: reviewedTransactionDigest(prepared.transaction)
  });
  return { prepared, request, row, input };
}
function holdings(
  wallets: string[]
): Awaited<ReturnType<typeof collectingDb.readAccountHoldings>> {
  return {
    account: {
      profile_id: 'profile',
      consolidation_key: 'profile',
      membership_hash: 'hash',
      wallets
    },
    holdings: [],
    snapshot: { block_number: 100, nextgen_block_number: null }
  };
}
let read: jest.SpyInstance;
let transition: jest.SpyInstance;
const simulate = jest.mocked(simulateStoredMarketBatch);
const membership = jest.mocked(collectingDb.readAccountHoldings);
let controller: AbortController;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  process.env.OPENSEA_API_KEY = 'test-only';
  process.env.MARKETPLACE_TRADING_ENABLED = 'true';
  controller = new AbortController();
  jest
    .mocked(withBatchPreflightLimit)
    .mockImplementation(async (_actor, _id, work) => work(controller.signal));
  membership.mockResolvedValue(holdings([BATCH_BUYER, BATCH_OWN]));
  read = jest.spyOn(marketOperationsDb, 'getForActor');
  transition = jest.spyOn(marketOperationsDb, 'transition');
  simulate.mockResolvedValue({ ...SNAPSHOT, estimated_gas: '167001' });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('returns only exact bound raw estimate, validates real batch calldata and never mutates the journal', async () => {
  const f = fixture();
  read.mockResolvedValue(f.row);
  const original = JSON.stringify(f.row);
  const result = await preflightMarketBatch(ID, auth(), f.input());
  expect(result).toEqual({
    operation_id: ID,
    revision: f.input().expected_revision,
    transaction_digest: f.input().transaction_digest,
    ...SNAPSHOT,
    estimated_gas: '167001'
  });
  expect(simulate).toHaveBeenCalledWith(f.prepared, controller.signal);
  expect(read).toHaveBeenCalledTimes(3);
  expect(membership).toHaveBeenCalledTimes(2);
  expect(transition).not.toHaveBeenCalled();
  expect(JSON.stringify(f.row)).toBe(original);
  expect(JSON.stringify(result)).not.toContain(f.prepared.transaction.data);
});

test.each(['anonymous', 'proxy', 'wrong wallet', 'wrong profile'])(
  'rejects %s actor before RPC',
  async (kind) => {
    const f = fixture();
    read.mockResolvedValue(f.row);
    const actor =
      kind === 'anonymous'
        ? auth(null)
        : kind === 'proxy'
          ? auth(BATCH_BUYER, 'profile', 'other')
          : kind === 'wrong wallet'
            ? auth(BATCH_OWN)
            : auth(BATCH_BUYER, 'other');
    await expect(preflightMarketBatch(ID, actor, f.input())).rejects.toThrow();
    expect(simulate).not.toHaveBeenCalled();
  }
);

test.each([
  'PREPARING',
  'UNKNOWN',
  'SUBMITTED',
  'MINED',
  'CONFIRMED',
  'FAILED'
] as const)('rejects %s state before RPC', async (state) => {
  const f = fixture();
  f.row.state = state;
  read.mockResolvedValue(f.row);
  await expect(
    preflightMarketBatch(ID, auth(), f.input())
  ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
  expect(simulate).not.toHaveBeenCalled();
});

test.each(['ACTIVE', 'RESOLVED', 'REJECTED_WITH_HASH'])(
  'preserves %s recovery fence',
  async (status) => {
    const f = fixture();
    f.row.send_attempt_json = {
      status: status === 'REJECTED_WITH_HASH' ? 'REJECTED' : status,
      ...(status === 'REJECTED_WITH_HASH'
        ? { transaction_hash: `0x${'a'.repeat(64)}` }
        : {})
    };
    read.mockResolvedValue(f.row);
    await expect(
      preflightMarketBatch(ID, auth(), f.input())
    ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    expect(simulate).not.toHaveBeenCalled();
  }
);

test('allows a positively rejected attempt without a hash and leaves it intact', async () => {
  const f = fixture();
  f.row.send_attempt_json = {
    status: 'REJECTED',
    rejection_reason: 'WALLET_NOT_REQUESTED'
  };
  read.mockResolvedValue(f.row);
  await expect(
    preflightMarketBatch(ID, auth(), f.input())
  ).resolves.toMatchObject({ estimated_gas: '167001' });
  expect(f.row.send_attempt_json).toEqual({
    status: 'REJECTED',
    rejection_reason: 'WALLET_NOT_REQUESTED'
  });
});

test.each([
  'revision',
  'digest',
  'expires',
  'zero expiry',
  'prepared expiry',
  'known hash',
  'rule',
  'request hash',
  'request quantity',
  'calldata',
  'gas reserve',
  'single'
])('rejects changed %s before RPC', async (kind) => {
  const f = fixture();
  if (kind === 'expires') f.row.expires_at = NOW;
  if (kind === 'zero expiry') f.row.expires_at = 0;
  if (kind === 'prepared expiry') f.prepared.validUntil = NOW;
  if (kind === 'known hash') f.row.transaction_hash = `0x${'a'.repeat(64)}`;
  if (kind === 'rule') f.row.rule_id = ID;
  if (kind === 'request hash') f.row.request_hash = 'a'.repeat(64);
  if (kind === 'request quantity') {
    f.request.items[1].allocations[0].recipient = BATCH_BUYER;
    f.row.request_hash = marketRequestHash(f.request);
  }
  if (kind === 'calldata') f.prepared.transaction.data = '0x1234';
  if (kind === 'gas reserve') f.prepared.gas.gas_reserve_wei = '1';
  if (kind === 'single') f.row.request_json = { ...f.request, kind: 'BUY' };
  const input = f.input();
  if (kind === 'revision') input.expected_revision = 'b'.repeat(64);
  if (kind === 'digest') input.transaction_digest = 'b'.repeat(64);
  read.mockResolvedValue(f.row);
  await expect(preflightMarketBatch(ID, auth(), input)).rejects.toThrow();
  expect(simulate).not.toHaveBeenCalled();
});

test.each(['payer', 'recipient'])(
  'requires current %s profile membership before simulation',
  async (kind) => {
    const f = fixture();
    read.mockResolvedValue(f.row);
    membership.mockResolvedValue(
      holdings(kind === 'payer' ? [BATCH_OWN] : [BATCH_BUYER])
    );
    await expect(
      preflightMarketBatch(ID, auth(), f.input())
    ).rejects.toMatchObject({ code: 'RECIPIENT_SCOPE_CHANGED' });
    expect(simulate).not.toHaveBeenCalled();
  }
);

test('checks revision again after membership and before RPC', async () => {
  const f = fixture();
  read
    .mockResolvedValueOnce(f.row)
    .mockResolvedValue({ ...f.row, updated_at: NOW + 1 });
  await expect(
    preflightMarketBatch(ID, auth(), f.input())
  ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
  expect(simulate).not.toHaveBeenCalled();
});

test.each([
  'revision',
  'state',
  'wallet',
  'profile',
  'expiry',
  'prepared expiry',
  'membership',
  'enabled',
  'aborted'
])('rejects concurrent %s change after RPC', async (kind) => {
  const f = fixture();
  read.mockResolvedValue(f.row);
  const input = f.input();
  simulate.mockImplementationOnce(async () => {
    if (kind === 'revision') f.row.updated_at++;
    if (kind === 'state') f.row.state = 'UNKNOWN';
    if (kind === 'wallet') f.row.wallet = BATCH_OWN;
    if (kind === 'profile') f.row.profile_id = 'other';
    if (kind === 'expiry') f.row.expires_at = NOW;
    if (kind === 'prepared expiry') f.prepared.validUntil = NOW;
    if (kind === 'membership') membership.mockResolvedValue(holdings([]));
    if (kind === 'enabled') process.env.MARKETPLACE_TRADING_ENABLED = 'false';
    if (kind === 'aborted') controller.abort();
    return { ...SNAPSHOT, estimated_gas: '167001' };
  });
  await expect(preflightMarketBatch(ID, auth(), input)).rejects.toThrow();
  expect(transition).not.toHaveBeenCalled();
});
