import {
  DELEGATIONS_TABLE,
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL
} from '../constants';
import { Delegation } from '../entities/IDelegation';
import { sqlExecutor } from '../sql-executor';

export async function fetchDelegatorForAirdropAddress(
  airdropAddress: string
): Promise<string | null> {
  return await fetchDelegation(
    [airdropAddress],
    'to_address',
    USE_CASE_AIRDROPS,
    MEMES_CONTRACT
  );
}

export async function fetchAirdropAddressForDelegators(
  airdropAddresses: string[]
): Promise<string | null> {
  return await fetchDelegation(
    airdropAddresses,
    'from_address',
    USE_CASE_AIRDROPS,
    MEMES_CONTRACT
  );
}

export async function fetchDelegation(
  addresses: string[],
  type: 'from_address' | 'to_address',
  useCase: number,
  collection: string
): Promise<string | null> {
  const result = await sqlExecutor.execute(
    `SELECT ${type} as my_address FROM ${DELEGATIONS_TABLE} 
    WHERE LOWER(to_address) in (:airdropAddresses)
    AND use_case in (:useCases) 
    AND expiry >= UNIX_TIMESTAMP() 
    AND collection in (:collections) 
    ORDER BY block DESC limit 1;`,
    {
      airdropAddresses: addresses.map((a) => a.toLowerCase()),
      useCases: [useCase, USE_CASE_ALL],
      collections: [collection, DELEGATION_ALL_ADDRESS]
    }
  );
  return result[0]?.my_address.toLowerCase() ?? null;
}

export async function fetchProcessedDelegations(
  collection: string,
  useCase: number
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
      FROM delegations
      WHERE 
        (collection = :collection OR collection = :anyCollection)
        AND (use_case = :useCase OR use_case = :allUseCase)
    ) AS ranked
    WHERE ranked.rn = 1;
    `,
    {
      collection,
      useCase,
      allUseCase: USE_CASE_ALL,
      anyCollection: DELEGATION_ALL_ADDRESS
    }
  );
  return results;
}
