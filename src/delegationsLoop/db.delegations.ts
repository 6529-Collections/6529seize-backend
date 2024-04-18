import {
  DELEGATIONS_TABLE,
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL,
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
  const wallets = consolidationKey.split('-');
  let tdhWallet = '';

  if (wallets.length < 2) {
    tdhWallet = consolidationKey;
  } else {
    const maxTdhBlock = await fetchLatestTDHBlockNumber();
    const result = await sqlExecutor.execute(
      `
    SELECT wallet FROM ${WALLETS_TDH_TABLE}
    WHERE 
      block = :maxTdhBlock  AND wallet in (:wallets)
    ORDER BY boosted_tdh DESC
    LIMIT 1; 
    `,
      {
        maxTdhBlock,
        wallets: wallets.map((w) => w.toLowerCase())
      }
    );
    tdhWallet = result[0]?.wallet.toLowerCase() ?? tdhWallet;
  }

  let airdropAddress = '';
  if (tdhWallet) {
    const processedDelegations = await sqlExecutor.execute(
      `SELECT * FROM 
      ${DELEGATIONS_TABLE} 
      WHERE 
        from_address = :tdhWallet 
        AND collection in (:collections) 
        AND use_case = :useCase 
      ORDER BY block DESC LIMIT 1;`,
      {
        tdhWallet,
        collections: [MEMES_CONTRACT, DELEGATION_ALL_ADDRESS],
        useCase: USE_CASE_AIRDROPS
      }
    );
    airdropAddress =
      processedDelegations[0]?.to_address.toLowerCase() ?? tdhWallet;
  }
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
    WHERE ranked.rn = 1 ${
      wallets ? ` AND LOWER(ranked.from_address) in (:wallets)` : ''
    };
    `,
    {
      collection,
      useCase,
      allUseCase: USE_CASE_ALL,
      anyCollection: DELEGATION_ALL_ADDRESS,
      wallets: wallets?.map((w) => w.toLowerCase())
    }
  );
  return results;
}
