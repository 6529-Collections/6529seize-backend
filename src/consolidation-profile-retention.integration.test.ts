import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  DELEGATION_ALL_ADDRESS,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  NEVER_DATE,
  NFTDELEGATION_BLOCKS_TABLE,
  USE_CASE_PRIMARY_ADDRESS
} from '@/constants';
import { IdentityEntity } from '@/entities/IIdentity';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';
import { IdentityConsolidationEffects, ProfileIdGenerator } from '@/identity';
import {
  anAddressConsolidationKeys,
  withAddressConsolidationKeys
} from '@/tests/fixtures/address-consolidation-key.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { IdentitiesService } from '@/api/identities/identities.service';
import {
  getDelegationPrimaryAddressForConsolidation,
  PRIMARY_ADDRESS_RETENTION_MATURITY_BLOCKS
} from '@/delegationsLoop/db.delegations';

const LATEST_PROCESSED_BLOCK = 2_000_000;
const FRESH_BLOCK = LATEST_PROCESSED_BLOCK - 100;
const MATURE_BLOCK =
  LATEST_PROCESSED_BLOCK - PRIMARY_ADDRESS_RETENTION_MATURITY_BLOCKS;

function withPrimaryAddressDelegations(
  delegations: { from: string; to: string; block: number }[]
): Seed {
  return {
    table: DELEGATIONS_TABLE,
    rows: delegations.map(({ from, to, block }) => ({
      block,
      from_address: from,
      to_address: to,
      collection: DELEGATION_ALL_ADDRESS,
      use_case: USE_CASE_PRIMARY_ADDRESS,
      expiry: NEVER_DATE,
      all_tokens: true,
      token_id: 0
    }))
  };
}

const withLatestProcessedDelegationBlock: Seed = {
  table: NFTDELEGATION_BLOCKS_TABLE,
  rows: [{ block: LATEST_PROCESSED_BLOCK, timestamp: 1_800_000_000 }]
};

// Alice's profile spans 0x1, 0x2 and 0x3. 0x1 has just left: the new TDH
// consolidations are 0x1 on its own and 0x2-0x3, which holds more TDH.
const splitSeeds = (primaryDelegationBlock: number): Seed[] => [
  withAddressConsolidationKeys(
    anAddressConsolidationKeys(['0x1', '0x2', '0x3'])
  ),
  withIdentities([
    anIdentity(
      { rep: 10, tdh: 10, basetdh_rate: 10, cic: 10 },
      {
        consolidation_key: '0x1-0x2-0x3',
        profile_id: 'alicePID',
        primary_address: '0x1',
        handle: 'alice'
      }
    )
  ]),
  withProfiles([
    aProfile({
      external_id: 'alicePID',
      primary_wallet: '0x1',
      handle: 'alice'
    })
  ]),
  withTdhConsolidations([
    aTdhConsolidation(['0x1'], { boosted_tdh: 2, boosted_tdh_rate: 2 }),
    aTdhConsolidation(['0x2-0x3'], { boosted_tdh: 8, boosted_tdh_rate: 8 })
  ]),
  // 0x1 named itself as the primary address.
  withPrimaryAddressDelegations([
    { from: '0x1', to: '0x1', block: primaryDelegationBlock }
  ]),
  withLatestProcessedDelegationBlock
];

function setUpService(): IdentityConsolidationEffects {
  const profileIdGenerator: ProfileIdGenerator = mock();
  const identitiesService: IdentitiesService = mock();
  when(profileIdGenerator.generate).mockReturnValue('generated-id');
  when(identitiesService.determinePrimaryAddress).mockImplementation(
    (wallets) => Promise.resolve(wallets[0]!)
  );
  return new IdentityConsolidationEffects(
    () => sqlExecutor,
    profileIdGenerator,
    identitiesService
  );
}

async function identitiesByKey(): Promise<Record<string, IdentityEntity>> {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await setUpService().syncIdentitiesWithTdhConsolidations(connection);
  });
  const identities = await sqlExecutor.execute<IdentityEntity>(
    `select * from ${IDENTITIES_TABLE}`
  );
  return Object.fromEntries(
    identities.map((identity) => [identity.consolidation_key, identity])
  );
}

describeWithSeed(
  'Profile retention ignores a recently delegated primary address',
  splitSeeds(FRESH_BLOCK),
  () => {
    it('keeps the profile with the part that holds more TDH', async () => {
      const byKey = await identitiesByKey();
      expect(byKey['0x2-0x3'].profile_id).toBe('alicePID');
      expect(byKey['0x2-0x3'].handle).toBe('alice');
      expect(byKey['0x1'].profile_id).toBe('generated-id');
      expect(byKey['0x1'].handle).toBeNull();
    });

    it('still reports the recent delegation as the primary address', async () => {
      await expect(
        getDelegationPrimaryAddressForConsolidation('0x1-0x2-0x3')
      ).resolves.toBe('0x1');
      await expect(
        getDelegationPrimaryAddressForConsolidation('0x1-0x2-0x3', {
          matureOnly: true
        })
      ).resolves.toBeNull();
    });
  }
);

describeWithSeed(
  'Profile retention follows a primary address delegated long enough ago',
  splitSeeds(MATURE_BLOCK),
  () => {
    it('keeps the profile with the part that holds the primary address', async () => {
      const byKey = await identitiesByKey();
      expect(byKey['0x1'].profile_id).toBe('alicePID');
      expect(byKey['0x1'].handle).toBe('alice');
      expect(byKey['0x2-0x3'].profile_id).toBe('generated-id');
      expect(byKey['0x2-0x3'].handle).toBeNull();
    });
  }
);

describeWithSeed(
  'Mature primary-address lookup prefers the newest mature delegation',
  [
    withPrimaryAddressDelegations([
      { from: '0x1', to: '0x2', block: MATURE_BLOCK - 10 },
      { from: '0x3', to: '0x3', block: MATURE_BLOCK },
      { from: '0x1', to: '0x1', block: FRESH_BLOCK }
    ]),
    withLatestProcessedDelegationBlock
  ],
  () => {
    it('skips a newer delegation that is not yet mature', async () => {
      await expect(
        getDelegationPrimaryAddressForConsolidation('0x1-0x2-0x3', {
          matureOnly: true
        })
      ).resolves.toBe('0x3');
    });
  }
);

describeWithSeed(
  'Mature primary-address lookup at the maturity boundary',
  [
    withPrimaryAddressDelegations([
      { from: '0x1', to: '0x1', block: MATURE_BLOCK + 1 }
    ]),
    withLatestProcessedDelegationBlock
  ],
  () => {
    it('treats a delegation one block short of maturity as recent', async () => {
      await expect(
        getDelegationPrimaryAddressForConsolidation('0x1-0x2', {
          matureOnly: true
        })
      ).resolves.toBeNull();
    });
  }
);
