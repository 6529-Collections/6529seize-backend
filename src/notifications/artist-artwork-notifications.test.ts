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
  visibility_group_id: null
};

function setup() {
  const preferences = {
    listRecipients: jest.fn(
      async (_artist: string, _time: number, after: string) =>
        after ? [] : ['viewer']
    ),
    isEnabled: jest.fn().mockResolvedValue(true)
  };
  const submissions = {
    find: jest.fn().mockResolvedValue(submission),
    canReceive: jest.fn().mockResolvedValue(true)
  };
  const receipts = new Map<string, unknown>();
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
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const profilePreferences = {
    get: jest.fn().mockResolvedValue(DEFAULT_PROFILE_PREFERENCES)
  };
  const notifier = { notifyOfArtistArtwork: jest.fn().mockResolvedValue([42]) };
  const push = jest.fn().mockResolvedValue(undefined);
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
  it.each([
    'COMPETITION_ENTRY_UPDATED',
    'COMPETITION_ENTRY_REMOVED',
    'COMPETITION_DECISION_COMPLETED',
    'CHAT'
  ])('ignores %s even with eligibility data', async (event_type) => {
    const deps = setup();
    await deps.service.deliver({ ...event, event_type }, {});
    expect(deps.preferences.listRecipients).not.toHaveBeenCalled();
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
  it('reuses the existing notification IDs after a push failure or repeated delivery', async () => {
    const deps = setup();
    deps.push.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(deps.service.deliver(event, {})).rejects.toThrow(
      'queue unavailable'
    );
    await deps.service.deliver(event, {});
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(1);
    expect(deps.push.mock.calls).toEqual([[[42]], [[42]], [[42]]]);
    expect(deps.preferences.isEnabled).toHaveBeenCalledWith(
      { subscriberId: 'viewer', artistId: 'artist' },
      {},
      200
    );
  });
  it('reuses original IDs across pages when a later push enqueue fails', async () => {
    const deps = setup();
    deps.preferences.listRecipients.mockImplementation(
      async (_artist, _time, after) => {
        if (!after) return ['viewer-a'];
        return after === 'viewer-a' ? ['viewer-b'] : [];
      }
    );
    deps.notifier.notifyOfArtistArtwork
      .mockResolvedValueOnce([41])
      .mockResolvedValueOnce([42]);
    deps.push
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(deps.service.deliver(event, {})).rejects.toThrow(
      'queue unavailable'
    );
    await deps.service.deliver(event, {});
    expect(deps.notifier.notifyOfArtistArtwork).toHaveBeenCalledTimes(2);
    // Re-enqueue is safe: the shared push transport deduplicates these stable IDs per device.
    expect(deps.push.mock.calls).toEqual([[[41]], [[42]], [[41]], [[42]]]);
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
    deps.groups.getGroupsUserIsEligibleFor.mockRejectedValueOnce(
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
