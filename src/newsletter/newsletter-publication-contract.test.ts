import 'reflect-metadata';
import { ADDRESS_CONSOLIDATION_KEY } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { AuthenticationContext } from '@/auth-context';
import { DropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { IdentitiesDb } from '@/identities/identities.db';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { NewsletterDb } from './newsletter.db';

const wallets = ['0x' + '12'.repeat(20), '0x' + '34'.repeat(20)];
const identity = anIdentity(
  {},
  {
    profile_id: 'publisher-profile',
    handle: 'journalist-test',
    primary_address: wallets[0],
    consolidation_key: 'publisher-consolidation'
  }
);
const identities = new IdentitiesDb(() => sqlExecutor);
const drops = new DropsDb(() => sqlExecutor);
const newsletter = new NewsletterDb(() => sqlExecutor);

describeWithSeed(
  'newsletter existing API persistence contracts',
  [
    withIdentities([identity]),
    withWaves([aWave({}, { id: 'destination', name: 'Newsletter' })]),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: wallets.map((address) => ({
        address,
        consolidation_key: identity.consolidation_key
      }))
    }
  ],
  () => {
    it.each(wallets)(
      'uses the same profile for public identity lookup and authenticated author resolution: %s',
      async (wallet) => {
        // These are the actual queries used by identity.fetcher and getAuthenticationContext.
        const publicIdentity = await identities.getIdentityByWallet(wallet);
        const authenticatedProfileId =
          await identities.getProfileIdByWallet(wallet);
        const context = new AuthenticationContext({
          authenticatedWallet: wallet,
          authenticatedProfileId,
          roleProfileId: null,
          activeProxyActions: []
        });
        expect(publicIdentity?.profile_id).toBe('publisher-profile');
        expect(context.getActingAsId()).toBe(publicIdentity?.profile_id);
      }
    );

    async function savePublication(rollback: boolean) {
      // DropCreationApiService/createOrUpdateDrop use these same repository methods
      // on one awaited transaction, including metadata, before returning a drop.
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await drops.insertDrop(
            {
              id: 'published',
              serial_no: null,
              wave_id: 'destination',
              author_id: identity.profile_id!,
              created_at: 1000,
              updated_at: null,
              title: null,
              parts_count: 1,
              reply_to_drop_id: null,
              reply_to_part_id: null,
              drop_type: DropType.CHAT,
              signature: null,
              is_additional_action_promised: null
            },
            connection,
            { deferMetrics: true }
          );
          await drops.insertDropMetadata(
            [
              {
                drop_id: 'published',
                wave_id: 'destination',
                data_key: 'newsletter_edition_id',
                data_value: 'daily:2026-09-23'
              }
            ],
            connection
          );
          if (rollback) throw new Error('publication rolled back');
        }
      );
    }

    it('finds the publication marker on the primary immediately after the drop transaction commits', async () => {
      await savePublication(false);
      expect(
        await newsletter.publishedEdition(
          'daily:2026-09-23',
          'destination',
          identity.profile_id!,
          {}
        )
      ).toBe('published');
    });

    it('does not leave a deduplication marker after a rolled-back drop transaction', async () => {
      await expect(savePublication(true)).rejects.toThrow(
        'publication rolled back'
      );
      expect(
        await newsletter.publishedEdition(
          'daily:2026-09-23',
          'destination',
          identity.profile_id!,
          {}
        )
      ).toBeNull();
    });
  }
);
