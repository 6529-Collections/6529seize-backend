import fetch from 'node-fetch';
import { fetchAllNftFinalSubscriptionsForContractAndToken } from './api.subscriptions.db';
import { fetchWalletConsolidationKeysView } from '../../../db';
import { areEqualAddresses } from '../../../helpers';
import { MEMES_CONTRACT, USE_CASE_MINTING } from '../../../constants';
import { fetchProcessedDelegations } from '../../../delegationsLoop/db.delegations';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '../../../exceptions';

export interface AllowlistResponse {
  allowlist_id: string;
  phase_id: string;
  valid: boolean;
  message?: string;
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
    // TODO: switch below
    // valid: !hasRanDelegationMapping,
    valid: hasRanDelegationMapping,
    message: hasRanDelegationMapping ? 'Delegation mapping has ran!' : undefined
  };
}

export async function getDistributionOperations(
  auth: string,
  allowlistId: string
): Promise<ALOperationsResponse[]> {
  const url = `https://allowlist-api.seize.io/allowlists/${allowlistId}/operations`;
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
  const url = `https://allowlist-api.seize.io/allowlists/${allowlistId}/results/phases/${phaseId}`;
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
  const url = `https://allowlist-api.seize.io/allowlists/${allowlistId}/phases/${phaseId}`;
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
  phase: 'airdrops' | 'allowlists',
  contract: string,
  tokenId: number,
  results: ALResultsResponse[]
): Promise<ResultsResponse[]> {
  // TODO: REMOVE THIS
  // results[0].wallet = '0xfe49a85e98941f1a115acd4beb98521023a25802';
  // results[0].amount = 4;
  // TODO: REMOVE THIS

  const subscriptions = await fetchAllNftFinalSubscriptionsForContractAndToken(
    contract,
    tokenId
  );

  const airdrops: ResultsResponse[] = [];
  const allowlists: ResultsResponse[] = [];

  const consolidationKeys = await fetchWalletConsolidationKeysView();
  const walletMintingDelegations = await fetchProcessedDelegations(
    MEMES_CONTRACT,
    USE_CASE_MINTING
  );

  const mapToMintingAddress = (wallet: string) => {
    return (
      walletMintingDelegations.find((d) =>
        areEqualAddresses(d.from_address, wallet)
      )?.to_address ?? wallet
    );
  };

  for (const result of results) {
    const consolidationKey =
      consolidationKeys.find((key) =>
        areEqualAddresses(key.wallet, result.wallet)
      )?.consolidation_key ?? result.wallet;
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
    } else if (phase === 'allowlists') {
      allowlists.push({
        wallet: mapToMintingAddress(result.wallet),
        amount: result.amount
      });
    }
  }

  return phase === 'airdrops' ? airdrops : allowlists;
}
