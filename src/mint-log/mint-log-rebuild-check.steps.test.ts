import { TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE } from '@/constants';
import { mintManifest } from '@/rebuild/manifests/mint.manifest';
import { mintRebuiltTables } from './mint-log-rebuild.run';

describe('the mint log rebuilder in the rebuild check', () => {
  it('declares exactly the tables the rebuild writes, and the cursor it sets', () => {
    const step = mintManifest.rebuilders.find((it) => it.id === 'mint.log');
    expect([...(step?.writes ?? [])].sort()).toEqual(
      [
        ...mintRebuiltTables(),
        TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE
      ].sort()
    );
  });
});
