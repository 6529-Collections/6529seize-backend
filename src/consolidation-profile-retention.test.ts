import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import { IdentitiesService } from '@/api/identities/identities.service';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { identitiesDb } from '@/identities/identities.db';
import { IdentityConsolidationEffects, ProfileIdGenerator } from '@/identity';
import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { profilesDb } from '@/profiles/profiles.db';
import { profilesService } from '@/profiles/profiles.service';
import { ConnectionWrapper, setSqlExecutor, SqlExecutor } from '@/sql-executor';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { aProfile } from '@/tests/fixtures/profile.fixture';

const alice = anIdentity(
  { tdh: 10, cic: 1 },
  {
    consolidation_key: '0x1-0x2',
    primary_address: '0x1',
    profile_id: 'alicePID',
    handle: 'alice'
  }
);
const bob = anIdentity(
  // The other profile wins the provisional metadata selection; the retained
  // profile's own metadata must still be restored after filtering merge sources.
  { tdh: 20, cic: 2 },
  {
    consolidation_key: '0x3-0x4',
    primary_address: '0x4',
    profile_id: 'bobPID',
    handle: 'bob'
  }
);
const aliceProfile = aProfile({
  external_id: 'alicePID',
  primary_wallet: '0x1',
  handle: 'alice'
});
const bobProfile = aProfile({
  external_id: 'bobPID',
  primary_wallet: '0x4',
  handle: 'bob'
});

describe('simultaneous consolidation split and merge profile retention', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { name: 'three plus one', keys: ['0x1-0x2-0x3', '0x4'], mergeSources: [] },
    {
      name: 'three plus one reversed',
      keys: ['0x4', '0x1-0x2-0x3'],
      mergeSources: []
    },
    {
      name: 'two cross-linked pairs',
      keys: ['0x1-0x3', '0x2-0x4'],
      mergeSources: []
    },
    {
      name: 'two cross-linked pairs reversed',
      keys: ['0x2-0x4', '0x1-0x3'],
      mergeSources: []
    },
    { name: 'pure merge', keys: ['0x1-0x2-0x3-0x4'], mergeSources: ['bobPID'] }
  ])(
    'preserves profile ownership for $name',
    async ({ keys, mergeSources }) => {
      const db = mock<SqlExecutor>();
      db.execute.mockImplementation(async (sql: string) =>
        sql.includes('floor(t.boosted_tdh)')
          ? keys.map((key) => ({ consolidation_key: key, tdh: 10 }))
          : []
      );
      setSqlExecutor(db);
      const generator = mock<ProfileIdGenerator>();
      const service = mock<IdentitiesService>();
      service.determinePrimaryAddress.mockImplementation(async (wallets) =>
        wallets.includes('0x1') ? '0x1' : '0x4'
      );
      const effects = new IdentityConsolidationEffects(
        () => db,
        generator,
        service
      );
      const connection: ConnectionWrapper<null> = { connection: null };
      jest
        .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
        .mockResolvedValue({
          '0x1': { identity: alice, profile: aliceProfile, consolidations: [] },
          '0x2': { identity: alice, profile: aliceProfile, consolidations: [] },
          '0x3': { identity: bob, profile: bobProfile, consolidations: [] },
          '0x4': { identity: bob, profile: bobProfile, consolidations: [] }
        });
      jest
        .spyOn(identitiesDb, 'deleteAddressConsolidations')
        .mockResolvedValue();
      jest.spyOn(identitiesDb, 'deleteIdentities').mockResolvedValue();
      const save = jest
        .spyOn(identitiesDb, 'bulkInsertIdentities')
        .mockResolvedValue();
      jest
        .spyOn(identitiesDb, 'syncProfileAddressesFromIdentitiesToProfiles')
        .mockResolvedValue();
      const updateProfile = jest
        .spyOn(identitiesDb, 'updateIdentityProfile')
        .mockResolvedValue();
      jest
        .spyOn(identitySubscriptionsDb, 'resyncWaveSubscriptionsMetrics')
        .mockResolvedValue();
      jest
        .spyOn(profilesDb, 'getProfileById')
        .mockImplementation(async (id) =>
          id === 'alicePID' ? aliceProfile : bobProfile
        );
      jest
        .spyOn(competitionEntryRepository, 'findNominationCompetitionIds')
        .mockResolvedValue([]);
      const merge = jest
        .spyOn(profilesService, 'mergeProfileSet')
        .mockResolvedValue();

      await effects.syncIdentitiesWithTdhConsolidations(connection);

      if (mergeSources.length) {
        expect(merge).toHaveBeenCalledTimes(1);
        expect(merge).toHaveBeenCalledWith(
          expect.objectContaining({ target: 'alicePID' }),
          connection
        );
        expect(Array.from(new Set(merge.mock.calls[0][0].toBeMerged))).toEqual(
          mergeSources
        );
      } else {
        expect(merge).not.toHaveBeenCalled();
      }
      expect(generator.generate).not.toHaveBeenCalled();
      const retainedProfiles = [aliceProfile, bobProfile].filter(
        (profile) => !mergeSources.includes(profile.external_id)
      );
      expect(save).toHaveBeenCalledWith(
        expect.arrayContaining(
          retainedProfiles.map((profile) =>
            expect.objectContaining({
              consolidation_key: keys.find((key) =>
                key.includes(profile.primary_wallet)
              ),
              profile_id: profile.external_id,
              primary_address: profile.primary_wallet
            })
          )
        ),
        connection
      );
      for (const profile of retainedProfiles) {
        expect(updateProfile).toHaveBeenCalledWith(
          keys.find((key) => key.includes(profile.primary_wallet)),
          expect.objectContaining({
            profile_id: profile.external_id,
            handle: profile.handle
          }),
          connection
        );
      }
    }
  );
});
