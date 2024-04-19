import fetch from 'node-fetch';
import { fetchAllNftFinalSubscriptionsForContractAndToken } from './api.subscriptions.db';
import { areEqualAddresses } from '../../../helpers';
import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  USE_CASE_MINTING
} from '../../../constants';
import { fetchProcessedDelegations } from '../../../delegationsLoop/db.delegations';
import {
  BadRequestException,
  CustomApiCompliantException
} from '../../../exceptions';
import { sqlExecutor } from '../../../sql-executor';
import { NFTFinalSubscription } from '../../../entities/ISubscription';

export interface AllowlistResponse {
  allowlist_id: string;
  phase_id: string;
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

export async function validateDistribution(
  auth: string,
  allowlistId: string,
  phaseId: string
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

export async function splitAllowlistResults(
  contract: string,
  tokenId: number,
  phaseName: string,
  results: ALResultsResponse[]
): Promise<{
  airdrops: ResultsResponse[];
  allowlists: ResultsResponse[];
}> {
  const wallets = results.map((r) => r.wallet.toLowerCase());
  const listHasDuplicates = new Set(wallets).size !== wallets.length;
  if (listHasDuplicates) {
    throw new BadRequestException('List has duplicates. Cannot process!');
  }

  const [subscriptions, walletMintingDelegations] = await Promise.all([
    fetchAllNftFinalSubscriptionsForContractAndToken(contract, tokenId),
    fetchProcessedDelegations(MEMES_CONTRACT, USE_CASE_MINTING)
  ]);

  const filteredSubscriptions = filterSubscriptions(wallets, subscriptions);

  const subscriptionRanks = new Map<string, number>();
  for (let i = 0; i < filteredSubscriptions.length; i++) {
    subscriptionRanks.set(filteredSubscriptions[i].consolidation_key, i + 1);
  }

  const phaseSubscriptions = filteredSubscriptions.length;

  const airdrops: ResultsResponse[] = [];
  for (const sub of filteredSubscriptions) {
    airdrops.push({
      wallet: sub.airdrop_address,
      amount: 1
    });
    const rank = subscriptionRanks.get(sub.consolidation_key);
    const updateQuery = `
        UPDATE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} 
        SET 
          phase = :phaseName, 
          phase_subscriptions = :phaseSubscriptions,
          phase_position = :rank
        WHERE id = :id`;
    await sqlExecutor.execute(updateQuery, {
      phaseName,
      phaseSubscriptions,
      rank,
      id: sub.id
    });
  }

  const allowlists: ResultsResponse[] = [];

  const mintingMap = new Map(
    walletMintingDelegations.map((d) => [
      d.from_address.toLowerCase(),
      d.to_address.toLowerCase()
    ])
  );
  const mapToMintingAddress = (wallet: string) =>
    mintingMap.get(wallet) ?? wallet;

  for (const result of results) {
    const walletAddress = result.wallet.toLowerCase();

    const subscription = filteredSubscriptions.find((s) =>
      s.consolidation_key
        .split('-')
        .some((k) => areEqualAddresses(k, walletAddress))
    );

    if (subscription) {
      if (result.amount > 1) {
        allowlists.push({
          wallet: mapToMintingAddress(walletAddress),
          amount: result.amount - 1
        });
      }
    } else {
      allowlists.push({
        wallet: mapToMintingAddress(result.wallet),
        amount: result.amount
      });
    }
  }

  const mergedAirDrops = mergeDuplicateWallets(airdrops);
  const mergedAllowlists = mergeDuplicateWallets(allowlists);

  return { airdrops: mergedAirDrops, allowlists: mergedAllowlists };
}

const mergeDuplicateWallets = (
  results: ResultsResponse[]
): ResultsResponse[] => {
  const mergedResults = new Map<string, number>();
  for (const r of results) {
    const currentAmount = mergedResults.get(r.wallet) ?? 0;
    mergedResults.set(r.wallet, currentAmount + r.amount);
  }
  return Array.from(mergedResults).map(([wallet, amount]) => ({
    wallet,
    amount
  }));
};

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
