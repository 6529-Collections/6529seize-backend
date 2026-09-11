import 'reflect-metadata';
import { AuthenticationContext } from '@/auth-context';
import {
  prepareRule,
  reconcileRule
} from '@/api/collect/collect-rules.service';
import {
  continueMarketOperation,
  prepareMarketOperation
} from '@/api/marketplace/marketplace.service';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import { CollectingRuleDefinition } from '@/collecting/collecting-rules.types';
import { MEMES_CONTRACT } from '@/constants';
import { marketOperationsDb } from '@/marketplace/market-operations.db';
import {
  MarketPreparation,
  MarketPrepared,
  MarketPrepareRequest
} from '@/marketplace/market-preparation';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const wallet = '0x0000000000000000000000000000000000000011';
const recipient = '0x0000000000000000000000000000000000000022';
const assetKey = collectingAssetKey(MEMES_CONTRACT, '1');
const mockRpc = { getTransactionReceipt: jest.fn(), getBlock: jest.fn() };
jest.mock('@/marketplace/market-chain', () => ({
  marketChain: () => ({ rpc: mockRpc })
}));
jest.mock('@/marketplace/market-reconciliation', () => ({
  reconcileMarketOperation: jest.fn()
}));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: {
    readAccountHoldings: jest.fn(async () => ({
      account: { wallets: ['0x0000000000000000000000000000000000000011'] }
    }))
  }
}));

const auth = new AuthenticationContext({
  authenticatedWallet: wallet,
  authenticatedProfileId: 'profile-1',
  roleProfileId: null,
  activeProxyActions: []
});
const trade: MarketPrepareRequest = {
  profile_id: 'profile-1',
  wallet,
  recipient,
  asset_key: assetKey,
  kind: 'BUY',
  quantity: '1',
  currency: MARKET_ZERO_ADDRESS,
  amount_wei: '100',
  acknowledge_external_recipient: true,
  order: { protocol_address: MARKET_SEAPORT, order_hash: `0x${'a'.repeat(64)}` }
};
function definition(): CollectingRuleDefinition {
  return {
    profile_id: 'profile-1',
    funding_wallet: wallet,
    recipient,
    plan_id: null,
    analysis_id: null,
    targets: [
      {
        asset_key: assetKey,
        target_quantity: '2',
        maximum_unit_price_wei: '100'
      }
    ],
    max_total_cost_wei: '250',
    max_gas_reserve_wei: '20',
    expires_at: Date.now() + 86400000,
    max_actions: 2
  };
}
function prepared(): MarketPrepared {
  return {
    intent: {
      kind: 'BUY',
      chainId: 1,
      wallet,
      recipient,
      asset: { contract: MEMES_CONTRACT, tokenId: '1', standard: 'ERC1155' },
      quantity: '1',
      currency: MARKET_ZERO_ADDRESS,
      maxTotalWei: '100',
      minNetWei: '0',
      fees: [],
      includeOptionalCreatorFees: true
    },
    recipientInProfile: false,
    approvalTransactions: [],
    transaction: {
      kind: 'TRANSACTION',
      chainId: 1,
      from: wallet,
      to: MARKET_SEAPORT,
      value: '100',
      data: '0x1234',
      purpose: 'FULFILL'
    },
    snapshot: {
      block_number: 100,
      block_hash: `0x${'b'.repeat(64)}`,
      block_timestamp: Math.floor(Date.now() / 1000)
    },
    gas: { gas_limit: '10', max_fee_per_gas: '2', gas_reserve_wei: '20' },
    feePolicyVersion: 'test'
  };
}

describeWithSeed(
  'collecting rule market integration with stubbed chain preparation',
  [],
  () => {
    let originalKey: string | undefined;
    let originalEnabled: string | undefined;
    beforeAll(() => {
      originalKey = process.env.OPENSEA_API_KEY;
      originalEnabled = process.env.MARKETPLACE_TRADING_ENABLED;
      process.env.OPENSEA_API_KEY = 'fixture-not-a-credential';
      process.env.MARKETPLACE_TRADING_ENABLED = 'true';
    });
    afterAll(() => {
      if (originalKey === undefined) delete process.env.OPENSEA_API_KEY;
      else process.env.OPENSEA_API_KEY = originalKey;
      if (originalEnabled === undefined)
        delete process.env.MARKETPLACE_TRADING_ENABLED;
      else process.env.MARKETPLACE_TRADING_ENABLED = originalEnabled;
    });
    beforeEach(() => {
      jest
        .spyOn(MarketPreparation.prototype, 'prepare')
        .mockResolvedValue(prepared());
      mockRpc.getTransactionReceipt.mockResolvedValue({
        status: 1,
        blockNumber: 100,
        blockHash: `0x${'b'.repeat(64)}`,
        gasUsed: BigInt(10),
        gasPrice: BigInt(1)
      });
      mockRpc.getBlock.mockResolvedValue({
        number: 101,
        hash: `0x${'b'.repeat(64)}`
      });
    });
    afterEach(() => jest.restoreAllMocks());

    it('atomically binds a rule before exposing a REVIEW transaction and retries without reserving twice', async () => {
      const rule = await collectingRulesService.create(
        definition(),
        'rule-request'
      );
      const result = await prepareRule(
        rule.id,
        auth,
        { expected_revision: rule.revision, trade },
        'operation-request'
      );
      expect(result.operation.state).toBe('REVIEW');
      expect(result.operation.transaction).toBeDefined();
      expect(result.rule.pending_review?.operation_id).toBe(
        result.operation.id
      );
      expect(
        (await marketOperationsDb.get(result.operation.id, 'profile-1')).rule_id
      ).toBe(rule.id);
      const retry = await prepareRule(
        rule.id,
        auth,
        { expected_revision: 1, trade },
        'operation-request'
      );
      expect(retry.operation.id).toBe(result.operation.id);
      expect(retry.rule.review_count).toBe(1);
      expect(MarketPreparation.prototype.prepare).toHaveBeenCalledTimes(1);
      await expect(
        prepareMarketOperation(auth, trade, 'operation-request')
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('rejects an over-budget quote without exposing an orphan review or retaining a rule reservation', async () => {
      const rule = await collectingRulesService.create(
        { ...definition(), max_total_cost_wei: '119' },
        'rule-request'
      );
      await expect(
        prepareRule(
          rule.id,
          auth,
          { expected_revision: 1, trade },
          'operation-request'
        )
      ).rejects.toThrow('lifetime review budget');
      const operations = await marketOperationsDb.list('profile-1');
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        state: 'FAILED',
        prepared_json: null,
        rule_id: rule.id
      });
      expect(
        await collectingRulesService.get(rule.id, 'profile-1')
      ).toMatchObject({ revision: 1, review_count: 0, pending_review: null });
      expect(
        await sqlExecutor.execute('SELECT * FROM collect_rule_operations')
      ).toEqual([]);
      await expect(
        continueMarketOperation(operations[0].id, auth)
      ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    });

    it('rejects a changed request while one operation is pending', async () => {
      const rule = await collectingRulesService.create(
        definition(),
        'rule-request'
      );
      await prepareRule(
        rule.id,
        auth,
        { expected_revision: 1, trade },
        'operation-request'
      );
      await expect(
        prepareRule(
          rule.id,
          auth,
          {
            expected_revision: 1,
            trade: { ...trade, quantity: '2', amount_wei: '200' }
          },
          'operation-request'
        )
      ).rejects.toMatchObject({ code: 'RULE_PENDING' });
      expect(
        (await collectingRulesService.get(rule.id, 'profile-1')).review_count
      ).toBe(1);
    });

    it('enforces the saved gas reserve and pause inside ordinary market continuation', async () => {
      const rule = await collectingRulesService.create(
        definition(),
        'rule-request'
      );
      const result = await prepareRule(
        rule.id,
        auth,
        { expected_revision: 1, trade },
        'operation-request'
      );
      jest.spyOn(MarketPreparation.prototype, 'prepare').mockResolvedValue({
        ...prepared(),
        gas: { gas_limit: '11', max_fee_per_gas: '2', gas_reserve_wei: '22' }
      });
      await expect(
        continueMarketOperation(result.operation.id, auth)
      ).rejects.toThrow('gas exceeds');
      expect(
        (await marketOperationsDb.get(result.operation.id, 'profile-1')).state
      ).toBe('REVIEW');
      jest
        .spyOn(MarketPreparation.prototype, 'prepare')
        .mockResolvedValue(prepared());
      await collectingRulesService.setPaused(
        rule.id,
        'profile-1',
        result.rule.revision,
        true
      );
      await expect(
        continueMarketOperation(result.operation.id, auth)
      ).rejects.toThrow('Pause or expiry');
      expect(
        (await marketOperationsDb.get(result.operation.id, 'profile-1')).state
      ).toBe('REVIEW');
    });

    it('keeps a confirmed operation pending when verified fill evidence is missing', async () => {
      const rule = await collectingRulesService.create(
        definition(),
        'rule-request'
      );
      const result = await prepareRule(
        rule.id,
        auth,
        { expected_revision: 1, trade },
        'operation-request'
      );
      await sqlExecutor.execute(
        'UPDATE market_operations SET state=:state,transaction_hash=:hash WHERE id=:id',
        {
          state: 'CONFIRMED',
          hash: `0x${'c'.repeat(64)}`,
          id: result.operation.id
        }
      );
      const reconciled = await reconcileRule(rule.id, auth);
      expect(reconciled).toMatchObject({
        acquired: [{ asset_key: assetKey, quantity: '0' }],
        spent_item_cost_wei: '0',
        action_count: 0
      });
      expect(reconciled.pending_review?.operation_id).toBe(result.operation.id);
    });
  }
);
