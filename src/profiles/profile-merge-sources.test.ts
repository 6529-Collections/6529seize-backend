import 'reflect-metadata';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { identitiesDb } from '@/identities/identities.db';
import { mentionAliasesDb } from '@/mention-aliases/mention-aliases.db';
import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { waveGroupNotificationSubscriptionsDb } from '@/notifications/wave-group-notification-subscriptions.db';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { ProfilesService } from '@/profiles/profiles.service';

const SOURCE = 'source-profile';
const TARGET = 'target-profile';
const CONNECTION = { connection: 'tx' };

/** Every merge step, in the order it ran before identities without a profiles row were merged too. */
const ALL_STEPS = [
  'artist artwork alerts',
  'statements',
  'given ratings',
  'received ratings',
  'proxies',
  'groups',
  'waves',
  'drops',
  'memes prevote artist profiles',
  'notifications',
  'xtdh grants',
  'subscriptions',
  'wave group subscriptions',
  'mention aliases',
  'reactions',
  'poll votes',
  'bookmarks',
  'curations',
  'quick vote skips',
  'profile waves',
  'delete source profile row',
  'boosts',
  'source logs',
  'target logs',
  'profile archived log',
  'profile groups'
];

const PROFILE_ROW_ONLY_STEPS = new Set([
  'groups',
  'memes prevote artist profiles',
  'poll votes',
  'delete source profile row',
  'profile archived log'
]);

function createService(sourceHasProfileRow: boolean) {
  const steps: string[] = [];
  const step = (name: string) =>
    jest.fn(async (): Promise<any> => {
      steps.push(name);
    });
  const profilesDb = {
    getProfileById: jest.fn(async (id: string) =>
      id === TARGET || sourceHasProfileRow
        ? { external_id: id, handle: `handle-of-${id}` }
        : null
    ),
    deleteProfile: step('delete source profile row'),
    updateProfileId: step('rename source profile row'),
    migrateAuthorIdsInWaves: step('waves'),
    migrateAuthorIdsInDrops: step('drops'),
    migrateProfileIdsInMemesPrevoteArtistProfiles: step(
      'memes prevote artist profiles'
    )
  };
  const ratingsService = {
    transferAllGivenProfileRatings: step('given ratings'),
    transferAllReceivedProfileRatings: step('received ratings')
  };
  const cicService = {
    getCicStatementsByProfileId: jest.fn(async (id: string) => {
      if (id === SOURCE) steps.push('statements');
      return [];
    })
  };
  const userGroupsDb = {
    migrateProfileIdsInGroups: step('groups'),
    findProfileGroupsWhereProfileIdIn: jest.fn(async (id: string) => {
      if (id === SOURCE) steps.push('profile groups');
      return [];
    }),
    deleteProfileIdsInProfileGroups: jest.fn(),
    insertProfileIdsInProfileGroups: jest.fn()
  };
  const service = new ProfilesService(
    profilesDb as any,
    ratingsService as any,
    { deleteAllProxiesAndActionsForProfile: step('proxies') } as any,
    cicService as any,
    userGroupsDb as any,
    { migrateBoosterIdsInBoosts: step('boosts') } as any,
    { updateIdentityIdsInNotifications: step('notifications') } as any,
    { mergeOnProfileIdChange: step('reactions') } as any,
    {} as any,
    { migrateGrantorId: step('xtdh grants') } as any,
    { mergeOnProfileIdChange: step('bookmarks') } as any,
    { mergeOnProfileIdChange: step('curations') } as any,
    { mergeOnProfileIdChange: step('quick vote skips') } as any,
    { mergeOnProfileIdChange: step('profile waves') } as any,
    { mergeOnProfileIdChange: step('poll votes') } as any
  );
  jest
    .spyOn(identitiesDb, 'getIdentityByProfileId')
    .mockResolvedValue({ profile_id: TARGET } as any);
  jest
    .spyOn(artistArtworkAlertsDb, 'mergeProfile')
    .mockImplementation(step('artist artwork alerts'));
  jest
    .spyOn(identitySubscriptionsDb, 'updateIdentityIdsInSubscriptions')
    .mockImplementation(step('subscriptions'));
  jest
    .spyOn(
      waveGroupNotificationSubscriptionsDb,
      'updateIdentityIdsInWaveGroupNotificationSubscriptions'
    )
    .mockImplementation(step('wave group subscriptions'));
  jest
    .spyOn(mentionAliasesDb, 'mergeProfileIds')
    .mockImplementation(step('mention aliases'));
  jest
    .spyOn(profileActivityLogsDb, 'changeSourceProfileIdInLogs')
    .mockImplementation(step('source logs'));
  jest
    .spyOn(profileActivityLogsDb, 'changeTargetProfileIdInLogs')
    .mockImplementation(step('target logs'));
  jest
    .spyOn(profileActivityLogsDb, 'insert')
    .mockImplementation(step('profile archived log'));
  return { service, steps, ratingsService };
}

async function merge(service: ProfilesService) {
  await (service as any).mergeProfileSetUnderCompetitionLocks(
    { toBeMerged: [SOURCE], target: TARGET },
    CONNECTION
  );
}

describe('profile merge of one source identity', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs every step, in the same order as before, when the source has a profiles row', async () => {
    const { service, steps } = createService(true);

    await merge(service);

    expect(steps).toEqual(ALL_STEPS);
  });

  it('moves the data keyed by the profile id when the source has no profiles row', async () => {
    const { service, steps, ratingsService } = createService(false);

    await merge(service);

    expect(steps).toEqual(
      ALL_STEPS.filter((name) => !PROFILE_ROW_ONLY_STEPS.has(name))
    );
    expect(ratingsService.transferAllGivenProfileRatings).toHaveBeenCalledWith(
      SOURCE,
      TARGET,
      CONNECTION
    );
    expect(
      ratingsService.transferAllReceivedProfileRatings
    ).toHaveBeenCalledWith(SOURCE, TARGET, CONNECTION);
  });
});
