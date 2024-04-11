import fetch from 'node-fetch';
import { fetchAllNftFinalSubscriptionsForContractAndToken } from './api.subscriptions.db';
import { fetchWalletConsolidationKeysView } from '../../../db';
import { areEqualAddresses } from '../../../helpers';
import { MEMES_CONTRACT, USE_CASE_MINTING } from '../../../constants';
import { fetchProcessedDelegations } from '../../../delegationsLoop/db.delegations';
import {
  BadRequestException,
  CustomApiCompliantException
} from '../../../exceptions';

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
  const operations = await getDistributionOperations(auth, allowlistId);
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

export async function getDistributionOperations(
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

export async function splitAllowlistResults(
  contract: string,
  tokenId: number,
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

  const subscriptions = await fetchAllNftFinalSubscriptionsForContractAndToken(
    contract,
    tokenId
  );

  const airdrops: ResultsResponse[] = [];
  const allowlists: ResultsResponse[] = [];

  const consolidationKeys = await fetchWalletConsolidationKeysView();
  const consolidationKeyMap = new Map(
    consolidationKeys.map((key) => [key.wallet, key.consolidation_key])
  );

  const walletMintingDelegations = await fetchProcessedDelegations(
    MEMES_CONTRACT,
    USE_CASE_MINTING
  );
  const delegationMap = new Map(
    walletMintingDelegations.map((d) => [d.from_address, d.to_address])
  );

  const mapToMintingAddress = (wallet: string) =>
    delegationMap.get(wallet) ?? wallet;

  for (const result of results) {
    const walletAddress = result.wallet.toLowerCase();
    const consolidationKey =
      consolidationKeyMap.get(walletAddress) ?? walletAddress;

    const subscription = subscriptions.find((s) =>
      areEqualAddresses(s.consolidation_key, consolidationKey)
    );

    if (subscription) {
      airdrops.push({
        wallet: subscription.airdrop_address,
        amount: 1
      });
      if (result.amount > 1) {
        allowlists.push({
          wallet: mapToMintingAddress(result.wallet),
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

  return { airdrops, allowlists };
}
