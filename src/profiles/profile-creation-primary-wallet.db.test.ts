import 'reflect-metadata';
import { IDENTITIES_TABLE, PROFILES_TABLE } from '@/constants';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ProfileClassification } from '@/entities/IProfile';
import { profilesService } from '@/profiles/profiles.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  anAddressConsolidationKeys,
  withAddressConsolidationKeys
} from '@/tests/fixtures/address-consolidation-key.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';

const PRIMARY = '0x00000000000000000000000000000000000000a1';
const SECOND = '0x00000000000000000000000000000000000000b2';

describeWithSeed(
  'profile creation from a consolidation wallet other than the primary',
  [
    withAddressConsolidationKeys(anAddressConsolidationKeys([PRIMARY, SECOND])),
    // A consolidated identity without a profile yet.
    withIdentities([
      {
        ...anIdentity(
          {},
          {
            consolidation_key: `${PRIMARY}-${SECOND}`,
            profile_id: 'identity-without-profile',
            primary_address: PRIMARY,
            handle: 'unused'
          }
        ),
        handle: null,
        normalised_handle: null
      }
    ])
  ],
  () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("stores the identity's primary address, not the creating wallet, as the profile's primary wallet", async () => {
      jest
        .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
        .mockResolvedValue({} as never);
      const [identity] = await sqlExecutor.execute<{
        consolidation_key: string;
      }>(`select consolidation_key from ${IDENTITIES_TABLE}`);
      expect(identity.consolidation_key.split('-')).toContain(SECOND);

      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        profilesService.createOrUpdateProfileWithGivenTransaction(
          {
            handle: 'second',
            creator_or_updater_wallet: SECOND,
            classification: ProfileClassification.PSEUDONYM,
            sub_classification: null,
            pfp_url: null
          },
          { connection }
        )
      );

      const profiles = await sqlExecutor.execute<{
        external_id: string;
        primary_wallet: string;
        created_by_wallet: string;
      }>(
        `select external_id, primary_wallet, created_by_wallet from ${PROFILES_TABLE}`
      );
      expect(profiles).toEqual([
        {
          external_id: 'identity-without-profile',
          primary_wallet: PRIMARY,
          created_by_wallet: SECOND
        }
      ]);
    });
  }
);
