import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { IdentityEntity } from '@/entities/IIdentity';
import {
  aCicRating,
  aRepRating,
  withRatings
} from '@/tests/fixtures/rating.fixture';
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
import { AddressConsolidationKey } from '@/entities/IAddressConsolidationKey';
import { Profile } from '@/entities/IProfile';
import { ProfileActivityLog } from '@/entities/IProfileActivityLog';

describeWithSeed(
  'IdentityConsolidationEffects level calculation',
  withIdentities([
    anIdentity(
      { rep: 10, tdh: 200, xtdh: 3 },
      {
        consolidation_key: '0x1',
        profile_id: '0x1',
        primary_address: '0x1',
        handle: '0x1'
      }
    ),
    anIdentity(
      { rep: 20, tdh: 100, xtdh: 3000 },
      {
        consolidation_key: '0x2',
        profile_id: '0x2',
        primary_address: '0x2',
        handle: '0x2'
      }
    ),
    anIdentity(
      { rep: -500, tdh: 0, xtdh: 1 },
      {
        consolidation_key: '0x3',
        profile_id: '0x3',
        primary_address: '0x3',
        handle: '0x3'
      }
    )
  ]),
  () => {
    let profileIdGenerator: ProfileIdGenerator;
    let identitiesService: IdentitiesService;
    let service: IdentityConsolidationEffects;

    beforeEach(() => {
      profileIdGenerator = mock();
      identitiesService = mock();
      when(profileIdGenerator.generate).mockReturnValue('generated-id');
      service = new IdentityConsolidationEffects(
        () => sqlExecutor,
        profileIdGenerator,
        identitiesService
      );
    });
    it('reset levels based on TDH, XTDH and REP', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await service.updateAllIdentitiesLevels(connection);
        }
      );
      const identities = await sqlExecutor.execute<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE}`
      );
      const grouped = identities.reduce(
        (acc, it) => {
          acc[it.profile_id!] = it.level_raw;
          return acc;
        },
        {} as Record<string, number>
      );
      expect(identities.length).toBe(3);
      expect(grouped['0x1']).toBe(213);
      expect(grouped['0x2']).toBe(3120);
      expect(grouped['0x3']).toBe(-499);
    });
  }
);

describeWithSeed(
  'IdentityConsolidationEffects metrics sync',
  [
    withIdentities([
      anIdentity(
        { rep: 10, tdh: 10, basetdh_rate: 10, cic: 10 },
        {
          consolidation_key: '0x1',
          profile_id: '0x1',
          primary_address: '0x1',
          handle: '0x1'
        }
      ),
      anIdentity(
        { rep: 1, tdh: 1, basetdh_rate: 1, cic: 1 },
        {
          consolidation_key: '0x2',
          profile_id: '0x2',
          primary_address: '0x2',
          handle: '0x2'
        }
      ),
      anIdentity(
        { rep: 3, tdh: 3, basetdh_rate: 3, cic: 3 },
        {
          consolidation_key: '0x3',
          profile_id: '0x3',
          primary_address: '0x3',
          handle: '0x3'
        }
      ),
      anIdentity(
        { rep: 0, tdh: 0, basetdh_rate: 0, cic: 0 },
        {
          consolidation_key: '0x4',
          profile_id: '0x4',
          primary_address: '0x4',
          handle: '0x4'
        }
      )
    ]),
    withRatings([
      aCicRating({
        rater_profile_id: '0x1',
        matter_target_id: '0x2',
        rating: 3
      }),
      aCicRating({
        rater_profile_id: '0x3',
        matter_target_id: '0x2',
        rating: 2
      }),
      aRepRating({
        rater_profile_id: '0x3',
        matter_target_id: '0x2',
        rating: 5,
        matter_category: 'cool guy'
      }),
      aCicRating({
        rater_profile_id: '0x1',
        matter_target_id: '0x3',
        rating: 2
      }),
      aCicRating({
        rater_profile_id: '0x2',
        matter_target_id: '0x3',
        rating: 1
      }),
      aRepRating({
        rater_profile_id: '0x2',
        matter_target_id: '0x3',
        rating: 3,
        matter_category: 'cool guy'
      })
    ]),
    withTdhConsolidations([
      aTdhConsolidation(['0x2'], {
        boosted_tdh: 5,
        boosted_tdh_rate: 5
      }),
      aTdhConsolidation(['0x3'], {
        boosted_tdh: 3,
        boosted_tdh_rate: 3
      })
    ])
  ],
  () => {
    let profileIdGenerator: ProfileIdGenerator;
    let identitiesService: IdentitiesService;
    let service: IdentityConsolidationEffects;

    beforeEach(() => {
      profileIdGenerator = mock();
      identitiesService = mock();
      when(profileIdGenerator.generate).mockReturnValue('generated-id');
      service = new IdentityConsolidationEffects(
        () => sqlExecutor,
        profileIdGenerator,
        identitiesService
      );
    });
    it('reset levels based on TDH, TDH Rate, CIC and REP based on sources of truth', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await service.syncIdentitiesMetrics(connection);
        }
      );

      const identities = await sqlExecutor.execute<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE}`
      );
      const grouped = identities.reduce(
        (acc, it) => {
          acc[it.profile_id!] = {
            rep: it.rep,
            tdh: it.tdh,
            cic: it.cic,
            tdh_rate: it.basetdh_rate
          };
          return acc;
        },
        {} as Record<
          string,
          { rep: number; cic: number; tdh: number; tdh_rate: number }
        >
      );
      expect(identities.length).toBe(4);

      expect(grouped['0x1'].tdh).toBe(0);
      expect(grouped['0x1'].tdh_rate).toBe(0);
      expect(grouped['0x1'].cic).toBe(0);
      expect(grouped['0x1'].rep).toBe(0);

      expect(grouped['0x2'].tdh).toBe(5);
      expect(grouped['0x2'].tdh_rate).toBe(5);
      expect(grouped['0x2'].cic).toBe(5);
      expect(grouped['0x2'].rep).toBe(5);

      expect(grouped['0x3'].tdh).toBe(3);
      expect(grouped['0x3'].tdh_rate).toBe(3);
      expect(grouped['0x3'].cic).toBe(3);
      expect(grouped['0x3'].rep).toBe(3);

      expect(grouped['0x4'].tdh).toBe(0);
      expect(grouped['0x4'].tdh_rate).toBe(0);
      expect(grouped['0x4'].cic).toBe(0);
      expect(grouped['0x4'].rep).toBe(0);
    });
  }
);

describeWithSeed(
  'IdentityConsolidationEffects consolidation and deconsolidation',
  [
    withAddressConsolidationKeys([
      ...anAddressConsolidationKeys(['0x1', '0x2']),
      ...anAddressConsolidationKeys(['0x3']),
      ...anAddressConsolidationKeys(['0x4'])
    ]),
    withIdentities([
      anIdentity(
        { rep: 10, tdh: 10, basetdh_rate: 10, cic: 10 },
        {
          consolidation_key: '0x1-0x2',
          profile_id: 'alicePID',
          primary_address: '0x1',
          handle: 'alice'
        }
      ),
      anIdentity(
        { rep: 1, tdh: 1, basetdh_rate: 1, cic: 1 },
        {
          consolidation_key: '0x3',
          profile_id: 'bobPID',
          primary_address: '0x3',
          handle: 'bob'
        }
      ),
      anIdentity(
        { rep: 1, tdh: 1, basetdh_rate: 1, cic: 1 },
        {
          consolidation_key: '0x4',
          profile_id: 'maryPID',
          primary_address: '0x4',
          handle: 'mary'
        }
      )
    ]),
    withProfiles([
      aProfile({
        external_id: 'alicePID',
        primary_wallet: '0x1',
        handle: 'alice'
      }),
      aProfile({
        external_id: 'bobPID',
        primary_wallet: '0x3',
        handle: 'bob'
      }),
      aProfile({
        external_id: 'maryPID',
        primary_wallet: '0x4',
        handle: 'mary'
      })
    ]),
    withTdhConsolidations([
      aTdhConsolidation(['0x1'], {
        boosted_tdh: 5,
        boosted_tdh_rate: 5
      }),
      aTdhConsolidation(['0x2'], {
        boosted_tdh: 4,
        boosted_tdh_rate: 4
      }),
      aTdhConsolidation(['0x3-0x4'], {
        boosted_tdh: 3,
        boosted_tdh_rate: 3
      })
    ])
  ],
  () => {
    let profileIdGenerator: ProfileIdGenerator;
    let identitiesService: IdentitiesService;
    let service: IdentityConsolidationEffects;

    beforeEach(() => {
      profileIdGenerator = mock();
      identitiesService = mock();
      when(profileIdGenerator.generate).mockReturnValue('generated-id');
      when(identitiesService.determinePrimaryAddress).mockImplementation(
        (wallets, consolidationKey) => {
          if (wallets.length === 1) {
            return Promise.resolve(wallets[0!]);
          } else if (consolidationKey === '0x1-0x2') {
            return Promise.resolve('0x1');
          } else if (consolidationKey === '0x3-0x4') {
            return Promise.resolve('0x4');
          }
          throw new Error(
            `Unmocked consolidation ${JSON.stringify({ wallets, consolidationKey })}, unable do determine primary address`
          );
        }
      );
      service = new IdentityConsolidationEffects(
        () => sqlExecutor,
        profileIdGenerator,
        identitiesService
      );
    });
    it('does correct merges', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await service.syncIdentitiesWithTdhConsolidations(connection);
        }
      );

      const identities = await sqlExecutor.execute<IdentityEntity>(
        `select * from ${IDENTITIES_TABLE}`
      );
      expect(identities.length).toBe(3);
      const groupedIdentitiesByPrimaryAddress = identities.reduce(
        (acc, it) => {
          acc[it.primary_address] = it;
          return acc;
        },
        {} as Record<string, IdentityEntity>
      );
      const profiles = await sqlExecutor.execute<Profile>(
        `select * from ${PROFILES_TABLE}`
      );
      expect(profiles.length).toBe(2);
      const groupedProfilesByPrimaryAddress = profiles.reduce(
        (acc, it) => {
          acc[it.primary_wallet] = it;
          return acc;
        },
        {} as Record<string, Profile>
      );
      const addressConsolidationKeys =
        await sqlExecutor.execute<AddressConsolidationKey>(
          `select * from ${ADDRESS_CONSOLIDATION_KEY}`
        );
      expect(addressConsolidationKeys.length).toBe(4);
      const groupedAddressConsolidationKeysByAddress =
        addressConsolidationKeys.reduce(
          (acc, it) => {
            acc[it.address] = it.consolidation_key;
            return acc;
          },
          {} as Record<string, string>
        );

      const logs = await sqlExecutor.execute<ProfileActivityLog>(
        `select * from ${PROFILES_ACTIVITY_LOGS_TABLE}`
      );
      expect(logs.length).toBe(1);
      const bobLog = logs.find((it) => it.profile_id === 'bobPID');
      expect(bobLog).toBeDefined();
      const bobLogContents = JSON.parse(bobLog!.contents);
      expect(bobLogContents.handle).toBe('bob');
      expect(bobLogContents.reason).toBe('CONFLICTING_CONSOLIDATION');

      expect(groupedAddressConsolidationKeysByAddress['0x1']).toBe('0x1');
      expect(groupedAddressConsolidationKeysByAddress['0x2']).toBe('0x2');
      expect(groupedAddressConsolidationKeysByAddress['0x3']).toBe('0x3-0x4');
      expect(groupedAddressConsolidationKeysByAddress['0x4']).toBe('0x3-0x4');

      const aliceDeconsolidated = groupedIdentitiesByPrimaryAddress['0x1'];
      expect(aliceDeconsolidated.consolidation_key).toBe('0x1');
      expect(aliceDeconsolidated.profile_id).toBe('alicePID');
      expect(aliceDeconsolidated.handle).toBe('alice');

      const formerAliceDeconsolidated =
        groupedIdentitiesByPrimaryAddress['0x2'];
      expect(formerAliceDeconsolidated.consolidation_key).toBe('0x2');
      expect(formerAliceDeconsolidated.profile_id).toBe('generated-id');
      expect(formerAliceDeconsolidated.handle).toBe(null);

      const maryConsolidated = groupedIdentitiesByPrimaryAddress['0x4'];
      expect(maryConsolidated.consolidation_key).toBe('0x3-0x4');
      expect(maryConsolidated.profile_id).toBe('maryPID');
      expect(maryConsolidated.handle).toBe('mary');

      const aliceDeconsolidatedProfile = groupedProfilesByPrimaryAddress['0x1'];
      expect(aliceDeconsolidatedProfile.handle).toBe(
        aliceDeconsolidated.handle
      );

      const maryConsolidatedProfile = groupedProfilesByPrimaryAddress['0x4'];
      expect(maryConsolidatedProfile.handle).toBe(maryConsolidated.handle);
    });
  }
);
