import { ArtistArtworkNotifications } from './artist-artwork-notifications';
import { ArtistArtworkSubmission } from './artist-artwork-submission.db';
import { CompetitionEventRepository } from '@/competitions/competition-event.repository';
import { NativeCompetitionEvent } from '@/competitions/native-competition-runtime.repository';
import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileNotificationLevel
} from '@/entities/IProfilePreferences';
import { RequestContext } from '@/request.context';

const event: NativeCompetitionEvent = {
  event_id: 'event',
  event_type: 'COMPETITION_ENTRY_CREATED',
  event_version: 1,
  occurred_at: 200,
  competition_id: 'competition',
  competition_entry_id: 'entry',
  wave_id: 'wave',
  drop_id: 'drop',
  data: { artwork_alert_eligible: true }
};
const submission: ArtistArtworkSubmission = {
  artist_id: 'artist',
  competition_id: 'competition',
  entry_id: 'entry',
  wave_id: 'wave',
  drop_id: 'drop',
  submitted_at: 200,
  artwork_title: 'A new work',
  competition_title: 'Main Stage',
  visibility_group_id: null,
  parent_visibility_group_id: null
};

function setup() {
  const receipts = new Map<string, unknown>();
  const recipients = ['viewer'];
  const preferences = {
    listPendingRecipients: jest.fn(async () =>
      recipients
        .filter((id) => !receipts.has(`event:artwork:${id}`))
        .slice(0, 100)
    ),
    isEnabled: jest.fn().mockResolvedValue(true)
  };
  const submissions = {
    find: jest.fn().mockResolvedValue(submission),
    canReceive: jest.fn().mockResolvedValue(true)
  };
  const effects = {
    applyEffect: jest.fn(
      async <T>(
        id: string,
        key: string,
        apply: (ctx: RequestContext) => Promise<T>
      ) => {
        const receipt = `${id}:${key}`;
        if (!receipts.has(receipt)) receipts.set(receipt, await apply({}));
        return receipts.get(receipt) as T;
      }
    ) as jest.MockedFunction<CompetitionEventRepository['applyEffect']>
  };
  const groups = {
    getGroupsUserIsEligibleForByIds: jest.fn().mockResolvedValue([])
  };
  const profilePreferences = {
    get: jest.fn().mockResolvedValue(DEFAULT_PROFILE_PREFERENCES),
    getMany: jest.fn().mockResolvedValue(new Map())
  };
  const notifier = { notifyOfArtistArtwork: jest.fn().mockResolvedValue([42]) };
  const push = { enqueueMany: jest.fn().mockResolvedValue(undefined) };
  const service = new ArtistArtworkNotifications(
    preferences,
    submissions,
    effects,
    groups,
    profilePreferences,
    notifier,
    push
  );
  return {
    service,
    recipients,
    preferences,
    submissions,
    effects,
    groups,
    profilePreferences,
    notifier,
    push
  };
}

describe('Artist artwork delivery', () => {
  const originalPushActivation = process.env.PUSH_NOTIFICATIONS_ACTIVATED;
  beforeEach(() => {
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPushActivation === undefined)
      delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
    else process.env.PUSH_NOTIFICATIONS_ACTIVATED = originalPushActivation;
  });
  it.each([
    'COMPETITION_ENTRY_UPDATED',
    'COMPETITION_ENTRY_REMOVED',
    'COMPETITION_DECISION_COMPLETED',
    'CHAT'
  ])('ignores %s even with eligibility data', async (event_type) => {
    const deps = setup();
    await deps.service.deliver({ ...event, event_type }, {});
    expect(deps.preferences.listPendingRecipients).not.toHaveBeenCalled();
  });
  it.each([undefined, false])(
    'ignores old, non-Main Stage, and originally anonymous events (%s)',
    async (eligible) => {
      const deps = setup();
      await deps.service.deliver(
        { ...event, data: { artwork_alert_eligible: eligible } },
        {}
      );
      expect(deps.submissions.find).not.toHaveBeenCalled();
    }
  );
  it('does not repeat notification or push-outbox writes on replay', async () => {
    const deps = setup();
    expect(await deps.service.deliver(event, {})).toBe(true);
    expect(await deps.service.deliver(event, {})).toBe(true);
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(1);
    expect(deps.push.enqueueMany).toHaveBeenCalledTimes(1);
    expect(deps.preferences.isEnabled).toHaveBeenCalledWith(
      { subscriberId: 'viewer', artistId: 'artist', submittedAt: 200 },
      {}
    );
  });
  it('resumes unfinished recipients after the time budget without repeating completed work', async () => {
    const deps = setup();
    deps.recipients.push('viewer-2');
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    deps.push.enqueueMany.mockImplementation(async () => {
      now = 21_000;
    });
    expect(await deps.service.deliver(event, {}, 20_000)).toBe(false);
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(1);
    expect(await deps.service.deliver(event, {}, 40_000)).toBe(true);
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(2);
    expect(deps.push.enqueueMany).toHaveBeenCalledTimes(2);
  });
  it('bounds a batch to 100 recipients and resumes the remainder', async () => {
    const deps = setup();
    deps.recipients.push(
      ...Array.from({ length: 100 }, (_, i) => `viewer-${i}`)
    );
    expect(await deps.service.deliver(event, {})).toBe(false);
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(100);
    expect(await deps.service.deliver(event, {})).toBe(true);
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(101);
  });
  it('skips group eligibility for a public wave and public parent', async () => {
    const deps = setup();
    await deps.service.deliver(event, {});
    expect(deps.groups.getGroupsUserIsEligibleForByIds).not.toHaveBeenCalled();
    expect(deps.profilePreferences.getMany).not.toHaveBeenCalled();
  });
  it('skips private group work for disabled global preferences', async () => {
    const deps = setup();
    deps.submissions.find.mockResolvedValue({
      ...submission,
      visibility_group_id: 'group'
    });
    const disabled = {
      ...DEFAULT_PROFILE_PREFERENCES,
      notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
    };
    deps.profilePreferences.getMany.mockResolvedValue(
      new Map([['viewer', disabled]])
    );
    deps.profilePreferences.get.mockResolvedValue(disabled);
    expect(await deps.service.deliver(event, {})).toBe(true);
    expect(deps.groups.getGroupsUserIsEligibleForByIds).not.toHaveBeenCalled();
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
  });
  it('does not lose a private alert when the preflight preference read lags behind the primary', async () => {
    const deps = setup();
    deps.submissions.find.mockResolvedValue({
      ...submission,
      visibility_group_id: 'group'
    });
    deps.profilePreferences.getMany.mockResolvedValueOnce(
      new Map([
        [
          'viewer',
          {
            ...DEFAULT_PROFILE_PREFERENCES,
            notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
          }
        ]
      ])
    );
    await expect(deps.service.deliver(event, {})).rejects.toThrow(
      'preferences changed'
    );
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
    expect(await deps.service.deliver(event, {})).toBe(true);
    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledTimes(
      1
    );
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(1);
  });
  it('resolves only required wave and parent groups before opening the effect transaction', async () => {
    const deps = setup();
    deps.submissions.find.mockResolvedValue({
      ...submission,
      visibility_group_id: 'wave-group',
      parent_visibility_group_id: 'parent-group'
    });
    await deps.service.deliver(event, {});
    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledWith(
      'viewer',
      ['wave-group', 'parent-group'],
      undefined
    );
    expect(
      deps.groups.getGroupsUserIsEligibleForByIds.mock.invocationCallOrder[0]
    ).toBeLessThan(deps.effects.applyEffect.mock.invocationCallOrder[0]);
  });
  it('retries when visibility changes after group resolution', async () => {
    const deps = setup();
    deps.submissions.find
      .mockResolvedValueOnce(submission)
      .mockResolvedValue({ ...submission, visibility_group_id: 'new-group' });
    await expect(deps.service.deliver(event, {})).rejects.toThrow(
      'visibility changed'
    );
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
  });
  it('rechecks a disabled preference before writing', async () => {
    const deps = setup();
    deps.preferences.isEnabled.mockResolvedValue(false);
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
  });
  it('rechecks entries that become anonymous, withdrawn or deleted while queued', async () => {
    const deps = setup();
    deps.submissions.find
      .mockResolvedValueOnce(submission)
      .mockResolvedValue(null);
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
  });
  it('suppresses private, muted or blocked content', async () => {
    const deps = setup();
    deps.submissions.canReceive.mockResolvedValue(false);
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
  });
  it('respects essential-only preferences', async () => {
    const deps = setup();
    deps.profilePreferences.get.mockResolvedValue({
      ...DEFAULT_PROFILE_PREFERENCES,
      notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
    });
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
  });
  it('retries policy lookup failures without writing an unchecked notification', async () => {
    const deps = setup();
    deps.submissions.find.mockResolvedValue({
      ...submission,
      visibility_group_id: 'group'
    });
    deps.groups.getGroupsUserIsEligibleForByIds.mockRejectedValueOnce(
      new Error('lookup unavailable')
    );
    await expect(deps.service.deliver(event, {})).rejects.toThrow(
      'lookup unavailable'
    );
    expect(deps.notifier.notifyOfArtistArtwork).not.toHaveBeenCalled();
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(1);
  });
});
