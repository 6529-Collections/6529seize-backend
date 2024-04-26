import {
  DELEGATIONS_TABLE,
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL,
  USE_CASE_PRIMARY_ADDRESS,
  WALLETS_TDH_TABLE
} from '../constants';
import { fetchLatestTDHBlockNumber } from '../db';
import { Delegation } from '../entities/IDelegation';
import { sqlExecutor } from '../sql-executor';

export async function fetchAirdropAddressForConsolidationKey(
  consolidationKey: string
): Promise<{
  tdh_wallet: string;
  airdrop_address: string;
}> {
  const wallets = consolidationKey.toLowerCase().split('-');
  let tdhWallet = '';

  if (wallets.length < 2) {
    tdhWallet = consolidationKey;
  } else {
    tdhWallet = await getHighestTdhWallet(wallets);
  }

  let airdropAddress = '';
  const results = await fetchProcessedDelegations(
    MEMES_CONTRACT,
    USE_CASE_AIRDROPS,
    wallets
  );

  airdropAddress = results[0]?.to_address.toLowerCase() ?? tdhWallet;

  return {
    tdh_wallet: tdhWallet,
    airdrop_address: airdropAddress
  };
}

export async function fetchProcessedDelegations(
  collection: string,
  useCase: number,
  wallets?: string[]
): Promise<Delegation[]> {
  const results = await sqlExecutor.execute(
    `
    SELECT * FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY from_address 
          ORDER BY 
            CASE 
              WHEN collection = :collection AND use_case = :useCase THEN 1
              WHEN collection = :collection AND use_case = :allUseCase THEN 2
              WHEN collection = :anyCollection AND use_case = :useCase THEN 3
              WHEN collection = :anyCollection AND use_case = :allUseCase THEN 4
              ELSE 5
            END,
            block DESC
        ) AS rn
      FROM ${DELEGATIONS_TABLE}
      WHERE 
        (collection = :collection OR collection = :anyCollection)
        AND (use_case = :useCase OR use_case = :allUseCase)
    ) AS ranked
    WHERE ranked.rn = 1 AND expiry >= :expiry ${
      wallets ? ` AND LOWER(ranked.from_address) in (:wallets)` : ''
    }
    ORDER BY ranked.block DESC;
    `,
    {
      collection,
      useCase,
      allUseCase: USE_CASE_ALL,
      anyCollection: DELEGATION_ALL_ADDRESS,
      expiry: Date.now() / 1000,
      wallets: wallets?.map((w) => w.toLowerCase())
    }
  );
  return results;
}

export async function getHighestTdhAddressForConsolidationKey(
  consolidationKey: string
): Promise<string> {
  const wallets = consolidationKey.toLowerCase().split('-');
  return getHighestTdhWallet(wallets);
}

export async function getHighestTdhWallet(wallets: string[]): Promise<string> {
  const maxTdhBlock = await fetchLatestTDHBlockNumber();
  const result = await sqlExecutor.execute(
    `
    SELECT wallet FROM ${WALLETS_TDH_TABLE}
    WHERE 
      block = :maxTdhBlock AND LOWER(wallet) in (:wallets)
    ORDER BY boosted_tdh DESC
    LIMIT 1; 
    `,
    {
      maxTdhBlock,
      wallets
    }
  );
  const tdhWallet: string = result[0]?.wallet.toLowerCase() ?? null;
  return tdhWallet;
}

export async function getDelegationPrimaryAddressForConsolidation(
  consolidationKey: string
): Promise<string | null> {
  const wallets = consolidationKey.toLowerCase().split('-');
  const result = await sqlExecutor.execute(
    `
    SELECT * FROM ${DELEGATIONS_TABLE}
    WHERE 
      LOWER(from_address) in (:wallets)
      AND LOWER(to_address) in (:wallets)
      AND use_case = :useCase
      AND expiry >= :expiry
      AND collection in (:collections)
    ORDER BY block DESC
    LIMIT 1;
    `,
    {
      wallets,
      useCase: USE_CASE_PRIMARY_ADDRESS,
      expiry: Date.now() / 1000,
      collections: [MEMES_CONTRACT, DELEGATION_ALL_ADDRESS]
    }
  );
  return result[0]?.to_address.toLowerCase() ?? null;
}
