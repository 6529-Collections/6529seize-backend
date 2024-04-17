import {
  DELEGATIONS_TABLE,
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL
} from '../constants';
import { Delegation } from '../entities/IDelegation';
import { sqlExecutor } from '../sql-executor';

export async function fetchAirdropAddressForDelegators(
  delegators: string[]
): Promise<string | null> {
  const results = await fetchProcessedDelegations(
    MEMES_CONTRACT,
    USE_CASE_AIRDROPS,
    delegators
  );
  return results?.[0].to_address ?? null;
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
            created_at DESC
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
