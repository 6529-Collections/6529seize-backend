import { ADDRESS_CONSOLIDATION_KEY } from '@/constants';
import { AddressConsolidationKey } from '@/entities/IAddressConsolidationKey';
import { Seed } from '@/tests/_setup/seed';
import { consolidationTools } from '@/consolidation-tools';

export function anAddressConsolidationKeys(
  addresses: string[]
): AddressConsolidationKey[] {
  const consolidationKey = consolidationTools.buildConsolidationKey(addresses);
  return addresses.map((address) => ({
    address: address,
    consolidation_key: consolidationKey
  }));
}

export function withAddressConsolidationKeys(
  entities: AddressConsolidationKey[]
): Seed {
  return {
    table: ADDRESS_CONSOLIDATION_KEY,
    rows: entities
  };
}
