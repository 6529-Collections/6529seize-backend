import {
  ZeroAddress,
  ZeroHash,
  type Result,
  type JsonRpcProvider
} from 'ethers';
import * as claims from '@/api/minting-claims/api.minting-claims.db';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import * as push from '@/api/push-notifications/push-notifications.service';
import * as chain from '@/drop-forge/drop-forge.chain';
import * as config from '@/drop-forge/drop-forge.config';
import * as evidence from '@/drop-forge/drop-forge.evidence';
import * as notifier from '@/drop-forge/drop-forge.notifier';
import * as policy from '@/drop-forge/drop-forge.policy';
import * as storage from '@/drop-forge/drop-forge.readiness.repository';
import {
  resolveReadinessCheckpoint,
  runReadinessDelivery
} from '@/drop-forge/drop-forge.readiness';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { STANDARD_MINT_PRICE_WEI } from '@/drop-forge/drop-forge.schedule';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';

const publicDelivery = 'readiness:3:2026-11-13T17:22:00Z';
const phase2Delivery = 'readiness:2:2026-11-13T16:58:00Z';
const root = '0x' + '12'.repeat(32);

function stubConfiguration(id: string, merkleRoot: string) {
  const { phase, claimId, scheduledAt } = resolveReadinessCheckpoint(id)!;
  jest.spyOn(Date, 'now').mockReturnValue(+scheduledAt + 20_000);
  jest.spyOn(rpc, 'getEthereumRpcProvider').mockReturnValue({
    getBlock: jest
      .fn()
      .mockResolvedValue({ number: 123, timestamp: +scheduledAt / 1000 + 12 })
  } as unknown as JsonRpcProvider);
  return jest.spyOn(chain, 'readDropForgeClaim').mockResolvedValue({
    startDate: BigInt(+phase.start / 1000),
    endDate: BigInt(+phase.end / 1000),
    merkleRoot,
    cost: BigInt(STANDARD_MINT_PRICE_WEI),
    paymentReceiver: testConfig.receiver,
    erc20: ZeroAddress,
    signingAddress: ZeroAddress,
    tokenId: BigInt(claimId),
    totalMax: BigInt(100)
  } as unknown as Result);
}

beforeEach(() => {
  jest
    .spyOn(policy, 'getDropForgePolicy')
    .mockReturnValue(
      testConfig as ReturnType<typeof policy.getDropForgePolicy>
    );
  jest.spyOn(config, 'getDropForgeReportingConfig').mockReturnValue(testConfig);
  jest.spyOn(dropForgeRepository, 'find').mockResolvedValue(null);
  jest
    .spyOn(claims, 'fetchMintingClaimByClaimId')
    .mockResolvedValue({ edition_size: 100 } as claims.MintingClaimRow);
  jest
    .spyOn(storage, 'recordReadinessCheck')
    .mockImplementation(
      async (_, post) => (await post({}))?.pending_push_notification_ids ?? []
    );
  jest
    .spyOn(notifier, 'postForgeReport')
    .mockResolvedValue({ drop_id: 'alert', pending_push_notification_ids: [] });
  jest.spyOn(push, 'sendIdentityPushNotifications').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

it('resolves Athens checkpoints in winter and summer and skips non-mint days', () => {
  expect(
    resolveReadinessCheckpoint('readiness:0:2026-11-13T15:30:00Z')?.time
  ).toBe('17:30');
  expect(
    resolveReadinessCheckpoint('readiness:1:2026-07-20T15:28:00Z')?.time
  ).toBe('18:28');
  expect(
    resolveReadinessCheckpoint('readiness:3:2026-11-12T17:22:00Z')
  ).toBeNull();
});

it('checks a manual public launch without a saved plan and stays quiet when public is live', async () => {
  const onChain = stubConfiguration(publicDelivery, ZeroHash);
  await runReadinessDelivery(publicDelivery);
  expect(onChain).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      contract: testConfig.creator
    }),
    123
  );
  expect(storage.recordReadinessCheck).toHaveBeenCalledTimes(1);
  expect(notifier.postForgeReport).not.toHaveBeenCalled();
});

it('reports a missing scheduled claim without needing a plan or signing configuration', async () => {
  stubConfiguration(publicDelivery, ZeroHash).mockResolvedValue(null);
  jest.mocked(claims.fetchMintingClaimByClaimId).mockResolvedValue(null);
  await runReadinessDelivery(publicDelivery);
  expect(notifier.postForgeReport).toHaveBeenCalledWith(
    testConfig,
    expect.stringMatching(
      /19:22 Athens[\s\S]*No Drop Forge card[\s\S]*missing on-chain/
    ),
    true,
    {}
  );
});

it('checks Phase 2 and Public allocations separately on a manual launch', async () => {
  stubConfiguration(phase2Delivery, root);
  jest
    .spyOn(storage, 'readinessMerkleRoots')
    .mockResolvedValue([{ phase: 'Phase 2', merkle_root: root }]);
  const wallet = testConfig.signer.toLowerCase();
  jest
    .spyOn(storage, 'readinessAllocations')
    .mockResolvedValue([
      [{ phase: 'Phase 2', wallet, total: 1 }],
      [{ phase: 'Public', wallet, total: 1 }]
    ]);
  jest.spyOn(evidence, 'evidenceForClaim').mockResolvedValue([]);
  jest
    .spyOn(mintingClaimActionsDb, 'findByContractAndClaimId')
    .mockResolvedValue([
      { action: 'PHASE2_AIRDROP', completed: true } as Awaited<
        ReturnType<typeof mintingClaimActionsDb.findByContractAndClaimId>
      >[number]
    ]);

  await runReadinessDelivery(phase2Delivery);

  expect(notifier.postForgeReport).toHaveBeenCalledTimes(1);
  const content = jest.mocked(notifier.postForgeReport).mock.calls[0][1];
  expect(content).toContain('Public subscription airdrops are incomplete');
  expect(content).not.toContain('Phase 2 subscription airdrops');
});
