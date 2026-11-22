import { Request } from 'express';
import { Logger } from '@/logging';
import fetch from 'node-fetch';
import { DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES } from '@/airdrop-phases';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  MEMES_CONTRACT,
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  USE_CASE_MINTING
} from '@/constants';
import { getDistributionAdminWallets } from '@/api/seize-settings';
import { fetchProcessedDelegations } from '../../../delegationsLoop/db.delegations';
import {
  BadRequestException,
  CustomApiCompliantException
} from '../../../exceptions';
import { sqlExecutor } from '../../../sql-executor';
import { equalIgnoreCase } from '../../../strings';
import { mergeDuplicateWallets } from '@/api/api-wallet-helpers';
import { getAuthenticatedWalletOrNull } from '../auth/auth';
import { NFTFinalSubscription } from '../generated/models/NFTFinalSubscription';
import {
  fetchAllNftFinalSubscriptionsForContractAndToken,
  fetchAllPublicFinalSubscriptionsForContractAndToken
} from './api.subscriptions.db';
import {
  IdentityWriteMode,
  subscriptionsIdentitySwitch
} from '@/subscriptions-identity/identity/identity-switch';
import {
  IDENTITY_SUBSCRIPTION_TABLES,
  LEGACY_SUBSCRIPTION_TABLES,
  SubscriptionTables
} from '@/subscriptions-identity/identity/subscription-tables';
import {
  compareKeyed,
  saveReport
} from '@/subscriptions-identity/writers/identity-reports';

const shadowLogger = Logger.get('SUBSCRIPTIONS_ALLOWLIST_SHADOW');

export interface AllowlistResponse {
  allowlist_id: string;
  phase_id?: string;
  valid: boolean;
  statusText?: string;
}

interface ALOperationsResponse {
  code: string;
}

interface ALResultsResponse {
  id: string;
  wallet: string;
  phaseId: string;
  allowlistId: string;
  phaseComponentId: string;
  amount: number;
}

interface ResultsResponse {
  wallet: string;
  amount: number;
}

export function authenticateSubscriptionsAdmin(
  req: Request<any, any, any, any, any>
) {
  const wallet = getAuthenticatedWalletOrNull(req);
  const isAdmin =
    wallet &&
    getDistributionAdminWallets().some((a) => equalIgnoreCase(a, wallet));
  return isAdmin;
}

export async function validateDistribution(
  auth: string,
  allowlistId: string,
  phaseId?: string
): Promise<AllowlistResponse> {
  const operations = await fetchDistributionOperations(auth, allowlistId);
  const hasRanDelegationMapping = operations.some(
    (o) => o.code === 'MAP_RESULTS_TO_DELEGATED_WALLETS'
  );
  return {
    allowlist_id: allowlistId,
    phase_id: phaseId,
    valid: !hasRanDelegationMapping,
    statusText: hasRanDelegationMapping
      ? 'This plan has used Delegation mapping. Cannot process!'
      : undefined
  };
}

export async function fetchDistributionOperations(
  auth: string,
  allowlistId: string
): Promise<ALOperationsResponse[]> {
  const url = `${process.env.ALLOWLIST_API_ENDPOINT}/allowlists/${allowlistId}/operations`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: auth
    }
  });
  const json = await response.json();
  if (response.status !== 200) {
    throw new CustomApiCompliantException(response.status, json.message);
  }
  return json;
}

export async function fetchPhaseName(
  auth: string,
  allowlistId: string,
  phaseId: string
): Promise<string> {
  const url = `${process.env.ALLOWLIST_API_ENDPOINT}/allowlists/${allowlistId}/phases/${phaseId}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: auth
    }
  });
  const json = await response.json();
  if (response.status !== 200) {
    throw new CustomApiCompliantException(response.status, json.message);
  }
  return json.name;
}

export async function fetchPhaseResults(
  auth: string,
  allowlistId: string,
  phaseId: string
): Promise<ALResultsResponse[]> {
  const url = `${process.env.ALLOWLIST_API_ENDPOINT}/allowlists/${allowlistId}/results/phases/${phaseId}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: auth
    }
  });
  const json = await response.json();
  if (response.status !== 200) {
    throw new CustomApiCompliantException(response.status, json.message);
  }
  return json;
}

function buildSubscriptionMaps(filteredSubscriptions: NFTFinalSubscription[]): {
  subscriptionRanks: Map<string, number>;
  subscriptionMap: Map<string, NFTFinalSubscription>;
} {
  const subscriptionRanks = new Map<string, number>();
  const subscriptionMap = new Map<string, NFTFinalSubscription>();

  for (let i = 0; i < filteredSubscriptions.length; i++) {
    const sub = filteredSubscriptions[i];
    subscriptionRanks.set(sub.consolidation_key, i + 1);
    const subWallets = sub.consolidation_key.split('-');
    for (const wallet of subWallets) {
      const walletKey = wallet.toLowerCase();
      if (!subscriptionMap.has(walletKey)) {
        subscriptionMap.set(walletKey, sub);
      }
    }
  }

  return { subscriptionRanks, subscriptionMap };
}

async function buildAirdropsAndUpdateSubscriptions(
  filteredSubscriptions: NFTFinalSubscription[],
  subscriptionRanks: Map<string, number>,
  phaseName: string,
  targets: readonly string[]
): Promise<ResultsResponse[]> {
  const phaseSubscriptions = filteredSubscriptions.length;
  const airdrops: ResultsResponse[] = [];
  const updateParams: Record<string, any> = {};

  for (let i = 0; i < filteredSubscriptions.length; i++) {
    const sub = filteredSubscriptions[i];
    airdrops.push({
      wallet: sub.airdrop_address,
      amount: sub.subscribed_count
    });
    const rank = subscriptionRanks.get(sub.consolidation_key);
    updateParams[`phaseName_${i}`] = phaseName;
    updateParams[`phaseSubscriptions_${i}`] = phaseSubscriptions;
    updateParams[`rank_${i}`] = rank;
    updateParams[`id_${i}`] = sub.id;
  }

  for (const target of filteredSubscriptions.length > 0 ? targets : []) {
    const batchUpdateQuery = `
      UPDATE ${target}
      SET
        phase = CASE id
          ${filteredSubscriptions.map((_, i) => `WHEN :id_${i} THEN :phaseName_${i}`).join(' ')}
        END,
        phase_subscriptions = CASE id
          ${filteredSubscriptions.map((_, i) => `WHEN :id_${i} THEN :phaseSubscriptions_${i}`).join(' ')}
        END,
        phase_position = CASE id
          ${filteredSubscriptions.map((_, i) => `WHEN :id_${i} THEN :rank_${i}`).join(' ')}
        END
      WHERE id IN (${filteredSubscriptions.map((_, i) => `:id_${i}`).join(', ')})
    `;
    await sqlExecutor.execute(batchUpdateQuery, updateParams);
  }

  return airdrops;
}

function buildAllowlists(
  results: ALResultsResponse[],
  subscriptionMap: Map<string, NFTFinalSubscription>,
  walletMintingDelegations: Array<{
    from_address: string;
    to_address: string;
  }>
): ResultsResponse[] {
  const allowlists: ResultsResponse[] = [];
  const mintingMap = new Map(
    walletMintingDelegations.map((d) => [
      d.from_address.toLowerCase(),
      d.to_address.toLowerCase()
    ])
  );
  const mapToMintingAddress = (wallet: string) =>
    mintingMap.get(wallet) ?? wallet;

  const usedSubscriptions = new Set<string>();
  for (const result of results) {
    const walletAddress = result.wallet.toLowerCase();
    const subscription = subscriptionMap.get(walletAddress);

    if (
      subscription &&
      !usedSubscriptions.has(subscription.consolidation_key)
    ) {
      usedSubscriptions.add(subscription.consolidation_key);
      if (result.amount > 1) {
        allowlists.push({
          wallet: mapToMintingAddress(walletAddress),
          amount: result.amount - 1
        });
      }
    } else {
      allowlists.push({
        wallet: mapToMintingAddress(walletAddress),
        amount: result.amount
      });
    }
  }

  return allowlists;
}

interface SplitResult {
  airdrops: ResultsResponse[];
  airdrops_unconsolidated: ResultsResponse[];
  allowlists: ResultsResponse[];
}

/**
 * Which final rows a phase pull splits, and which tables it writes:
 * before the identity switch the legacy rows (and, in shadow, the identity
 * rows again, split on their own and compared); after it the identity rows,
 * with the same phase written by id to both tables (each final row has one
 * id in both).
 */
async function phaseTargets(): Promise<{
  readonly mode: IdentityWriteMode;
  readonly source: SubscriptionTables;
  readonly targets: string[];
}> {
  const mode = await subscriptionsIdentitySwitch.writeModeOrFail();
  return mode === 'TRUTH'
    ? {
        mode,
        source: IDENTITY_SUBSCRIPTION_TABLES,
        targets: [
          IDENTITY_SUBSCRIPTION_TABLES.final,
          LEGACY_SUBSCRIPTION_TABLES.final
        ]
      }
    : {
        mode,
        source: LEGACY_SUBSCRIPTION_TABLES,
        targets: [LEGACY_SUBSCRIPTION_TABLES.final]
      };
}

async function reportPhase(
  mode: IdentityWriteMode,
  contract: string,
  tokenId: number,
  phaseName: string,
  legacy: ResultsResponse[],
  identity: ResultsResponse[]
): Promise<void> {
  const asMap = (rows: ResultsResponse[]) =>
    new Map(rows.map((r) => [r.wallet.toLowerCase(), `x${r.amount}`]));
  const diffs = compareKeyed(asMap(legacy), asMap(identity));
  await saveReport({
    kind: 'PHASE',
    mode,
    contract,
    tokenId,
    verdict: diffs.length === 0 ? 'MATCH' : 'DIFF',
    legacyRows: legacy.length,
    identityRows: identity.length,
    diffs,
    notes: [`phase ${phaseName}`]
  });
}

/** In shadow, splits the identity rows on their own and compares. */
async function shadowSplit(
  mode: IdentityWriteMode,
  contract: string,
  tokenId: number,
  phaseName: string,
  legacy: ResultsResponse[],
  split: () => Promise<ResultsResponse[]>
): Promise<void> {
  if (mode !== 'SHADOW') {
    return;
  }
  try {
    await reportPhase(
      mode,
      contract,
      tokenId,
      phaseName,
      legacy,
      await split()
    );
  } catch (error) {
    // The shadow never stops the legacy pull.
    shadowLogger.error(`[SHADOW PHASE SPLIT FAILED] [${phaseName}]`, error);
  }
}

export async function splitAllowlistResults(
  contract: string,
  tokenId: number,
  phaseName: string,
  results: ALResultsResponse[]
): Promise<SplitResult> {
  const { mode, source, targets } = await phaseTargets();
  const result = await splitAllowlistResultsOn(
    contract,
    tokenId,
    phaseName,
    results,
    source,
    targets
  );
  await shadowSplit(
    mode,
    contract,
    tokenId,
    phaseName,
    result.airdrops,
    async () =>
      (
        await splitAllowlistResultsOn(
          contract,
          tokenId,
          phaseName,
          results,
          IDENTITY_SUBSCRIPTION_TABLES,
          [IDENTITY_SUBSCRIPTION_TABLES.final]
        )
      ).airdrops
  );
  return result;
}

async function splitAllowlistResultsOn(
  contract: string,
  tokenId: number,
  phaseName: string,
  results: ALResultsResponse[],
  source: SubscriptionTables,
  targets: readonly string[]
): Promise<SplitResult> {
  const wallets = results.map((r) => r.wallet.toLowerCase());
  const listHasDuplicates = new Set(wallets).size !== wallets.length;
  if (listHasDuplicates) {
    throw new BadRequestException('List has duplicates. Cannot process!');
  }

  const [subscriptions, walletMintingDelegations] = await Promise.all([
    fetchAllNftFinalSubscriptionsForContractAndToken(contract, tokenId, source),
    fetchProcessedDelegations(
      MEMES_CONTRACT,
      USE_CASE_MINTING,
      undefined,
      equalIgnoreCase(contract, MEMES_CONTRACT) ? tokenId : null
    )
  ]);

  const filteredSubscriptions = filterSubscriptions(wallets, subscriptions);
  const { subscriptionRanks, subscriptionMap } = buildSubscriptionMaps(
    filteredSubscriptions
  );
  const airdrops = await buildAirdropsAndUpdateSubscriptions(
    filteredSubscriptions,
    subscriptionRanks,
    phaseName,
    targets
  );
  const allowlists = buildAllowlists(
    results,
    subscriptionMap,
    walletMintingDelegations
  );

  const mergedAirdrops = mergeDuplicateWallets(airdrops);
  const mergedAllowlists = mergeDuplicateWallets(allowlists);

  return {
    airdrops: mergedAirdrops,
    airdrops_unconsolidated: airdrops,
    allowlists: mergedAllowlists
  };
}

export async function getPublicSubscriptions(
  contract: string,
  tokenId: number
): Promise<{
  airdrops: ResultsResponse[];
}> {
  const { mode, source, targets } = await phaseTargets();
  const result = await getPublicSubscriptionsOn(
    contract,
    tokenId,
    source,
    targets
  );
  await shadowSplit(
    mode,
    contract,
    tokenId,
    'Public',
    result.airdrops,
    async () =>
      (
        await getPublicSubscriptionsOn(
          contract,
          tokenId,
          IDENTITY_SUBSCRIPTION_TABLES,
          [IDENTITY_SUBSCRIPTION_TABLES.final]
        )
      ).airdrops
  );
  return result;
}

async function getPublicSubscriptionsOn(
  contract: string,
  tokenId: number,
  source: SubscriptionTables,
  targets: readonly string[]
): Promise<{
  airdrops: ResultsResponse[];
}> {
  const publicSubscriptions =
    await fetchAllPublicFinalSubscriptionsForContractAndToken(
      contract,
      tokenId,
      source
    );

  const subscriptionRanks = new Map<string, number>();
  for (let i = 0; i < publicSubscriptions.length; i++) {
    subscriptionRanks.set(publicSubscriptions[i].consolidation_key, i + 1);
  }

  const phaseSubscriptions = publicSubscriptions.length;

  const airdrops: ResultsResponse[] = [];
  const updateParams: Record<string, any> = {};

  for (let i = 0; i < publicSubscriptions.length; i++) {
    const sub = publicSubscriptions[i];
    airdrops.push({
      wallet: sub.airdrop_address,
      amount: 1
    });
    const rank = subscriptionRanks.get(sub.consolidation_key);
    updateParams[`phaseName_${i}`] = 'Public';
    updateParams[`phaseSubscriptions_${i}`] = phaseSubscriptions;
    updateParams[`rank_${i}`] = rank;
    updateParams[`id_${i}`] = sub.id;
  }

  for (const target of publicSubscriptions.length > 0 ? targets : []) {
    const batchUpdateQuery = `
      UPDATE ${target}
      SET
        phase = CASE id
          ${publicSubscriptions.map((_, i) => `WHEN :id_${i} THEN :phaseName_${i}`).join(' ')}
        END,
        phase_subscriptions = CASE id
          ${publicSubscriptions.map((_, i) => `WHEN :id_${i} THEN :phaseSubscriptions_${i}`).join(' ')}
        END,
        phase_position = CASE id
          ${publicSubscriptions.map((_, i) => `WHEN :id_${i} THEN :rank_${i}`).join(' ')}
        END
      WHERE id IN (${publicSubscriptions.map((_, i) => `:id_${i}`).join(', ')})
    `;
    await sqlExecutor.execute(batchUpdateQuery, updateParams);
  }

  const mergedAirDrops = mergeDuplicateWallets(airdrops);

  return { airdrops: mergedAirDrops };
}

function filterSubscriptions(
  wallets: string[],
  subscriptions: NFTFinalSubscription[]
): NFTFinalSubscription[] {
  const walletSet = new Set(wallets);
  return subscriptions.filter((s) => {
    const subWallets = s.consolidation_key.split('-');
    return !s.phase && subWallets.some((sw) => walletSet.has(sw));
  });
}

export async function resetAllowlist(contract: string, tokenId: number) {
  const contractLower = contract.toLowerCase();
  const mode = await subscriptionsIdentitySwitch.writeModeOrFail();
  // After the switch both final tables reset together. In shadow the
  // identity table is reset afterwards, on its own, so a failure there
  // never undoes the legacy reset.
  const finals =
    mode === 'TRUTH'
      ? [SUBSCRIPTIONS_NFTS_FINAL_TABLE, IDENTITY_SUBSCRIPTION_TABLES.final]
      : [SUBSCRIPTIONS_NFTS_FINAL_TABLE];
  await sqlExecutor.executeNativeQueriesInTransaction(
    async (wrappedConnection) => {
      for (const final of finals) {
        await sqlExecutor.execute(
          `UPDATE ${final}
            SET phase = NULL, phase_subscriptions = -1, phase_position = -1
            WHERE contract = :contract AND token_id = :tokenId`,
          { contract, tokenId },
          { wrappedConnection }
        );
      }

      await sqlExecutor.execute(
        `DELETE FROM ${DISTRIBUTION_TABLE}
         WHERE contract = :contract
           AND card_id = :tokenId
           AND phase NOT IN (:automaticAirdropPhases)`,
        {
          contract: contractLower,
          tokenId,
          automaticAirdropPhases: [...DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES]
        },
        { wrappedConnection }
      );

      await sqlExecutor.execute(
        `DELETE FROM ${MINTING_MERKLE_PROOFS_TABLE}
         WHERE merkle_root IN (
           SELECT merkle_root
           FROM ${MINTING_MERKLE_ROOTS_TABLE}
           WHERE contract = :contract
             AND card_id = :tokenId
         )`,
        {
          contract: contractLower,
          tokenId
        },
        { wrappedConnection }
      );

      await sqlExecutor.execute(
        `DELETE FROM ${MINTING_MERKLE_ROOTS_TABLE}
         WHERE contract = :contract
           AND card_id = :tokenId`,
        {
          contract: contractLower,
          tokenId
        },
        { wrappedConnection }
      );

      await sqlExecutor.execute(
        `DELETE FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE contract = :contract AND card_id = :tokenId`,
        {
          contract: contractLower,
          tokenId
        },
        { wrappedConnection }
      );
    }
  );
  if (mode === 'SHADOW') {
    try {
      await sqlExecutor.execute(
        `UPDATE ${IDENTITY_SUBSCRIPTION_TABLES.final}
          SET phase = NULL, phase_subscriptions = -1, phase_position = -1
          WHERE contract = :contract AND token_id = :tokenId`,
        { contract, tokenId }
      );
    } catch (error) {
      shadowLogger.error('[SHADOW ALLOWLIST RESET FAILED]', error);
    }
  }
}
