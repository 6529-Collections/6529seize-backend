import {
  DELEGATIONS_TABLE,
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL
} from '../constants';
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
