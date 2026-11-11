import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import {
  getMentionedWaveIdsWithDetails,
  redactMentionedWavesOutsideShowableSet,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';

function mentionedWave(id: string) {
  return {
    wave_name_in_content: id,
    wave_id: id,
    wave: {
      id,
      name: `name of ${id}`,
      visibility_group_id: null,
      is_direct_message: false
    }
  };
}

function embeddedDrop(id: string, mentionedWaveIds: string[]) {
  return {
    id,
    author: { id: 'embedded-author', subscribed_actions: [] },
    mentioned_waves: mentionedWaveIds.map(mentionedWave),
    parts: [{ part_id: 1, content: 'embedded', quoted_drop: null }],
    reply_to: null
  };
}

function rootDrop(): ApiDrop {
  return {
    id: 'root',
    serial_no: 1,
    drop_type: ApiDropType.Chat,
    wave: { id: 'wave-1', visibility_group_id: null },
    author: { id: 'root-author', subscribed_actions: [] },
    viewer_context: { author_blocked: false, drop_hidden: false },
    moderation: { status: 'VISIBLE', can_view: true },
    mentioned_waves: [
      mentionedWave('top-level-public'),
      mentionedWave('subwave-of-private-parent')
    ],
    parts: [
      {
        part_id: 1,
        content: 'root',
        quoted_drop: {
          drop_id: 'quoted',
          drop_part_id: 1,
          drop: embeddedDrop('quoted', ['quoted-subwave'])
        }
      }
    ],
    reply_to: {
      drop_id: 'replied',
      drop_part_id: 1,
      drop: embeddedDrop('replied', ['subwave-of-public-parent'])
    }
  } as unknown as ApiDrop;
}

describe('mentioned wave broadcast details', () => {
  it('collects mentioned wave ids with details from root and embedded drops', () => {
    const drop = rootDrop();
    drop.mentioned_waves.push({
      wave_name_in_content: 'no-details',
      wave_id: 'no-details'
    });

    expect(
      getMentionedWaveIdsWithDetails(drop).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      'quoted-subwave',
      'subwave-of-private-parent',
      'subwave-of-public-parent',
      'top-level-public'
    ]);
  });

  it('omits details for every mentioned wave outside the showable set', () => {
    const drop = rootDrop();
    const before = JSON.stringify(drop);

    const result = redactMentionedWavesOutsideShowableSet(
      drop,
      new Set(['top-level-public', 'subwave-of-public-parent'])
    );

    expect(JSON.stringify(drop)).toBe(before);
    expect(result.mentioned_waves[0].wave?.id).toBe('top-level-public');
    expect(result.mentioned_waves[1]).toEqual({
      wave_name_in_content: 'subwave-of-private-parent',
      wave_id: 'subwave-of-private-parent'
    });
    expect(
      result.parts[0].quoted_drop?.drop?.mentioned_waves[0]
    ).not.toHaveProperty('wave');
    expect(result.reply_to?.drop?.mentioned_waves[0].wave?.id).toBe(
      'subwave-of-public-parent'
    );
  });

  it('returns the same drop when every mentioned wave is showable', () => {
    const drop = rootDrop();
    expect(
      redactMentionedWavesOutsideShowableSet(
        drop,
        new Set(getMentionedWaveIdsWithDetails(drop))
      )
    ).toBe(drop);
  });

  describe('broadcast frame', () => {
    beforeEach(() => {
      jest
        .spyOn(competitionAnonymityService, 'hiddenDropIds')
        .mockResolvedValue(new Set());
      jest
        .spyOn(contentModerationDb, 'getViewerContextsForDrop')
        .mockResolvedValue({});
    });

    afterEach(() => jest.restoreAllMocks());

    function setup(showable: string[]) {
      const appWebSockets = { send: jest.fn().mockResolvedValue(undefined) };
      const connections = {
        getCurrentlyOnlineCommunityMemberConnectionIds: jest
          .fn()
          .mockResolvedValue([
            { connectionId: 'c-1', profileId: 'reader-1' },
            { connectionId: 'c-2', profileId: 'reader-2' }
          ]),
        findDropIdsReadableByWaveAudience: jest
          .fn()
          .mockImplementation(({ dropIds }: { dropIds: string[] }) =>
            Promise.resolve(new Set(dropIds))
          ),
        findWaveIdsShowableToAnyAudience: jest
          .fn()
          .mockResolvedValue(new Set(showable))
      };
      const notifier = new WsListenersNotifier(
        appWebSockets as never,
        connections as never
      );
      return { appWebSockets, connections, notifier };
    }

    it('looks up mentioned waves once per frame and omits subwave details without a public parent', async () => {
      const { appWebSockets, connections, notifier } = setup([
        'top-level-public',
        'subwave-of-public-parent'
      ]);

      await notifier.notifyAboutDropUpdate(rootDrop(), {});

      expect(
        connections.findWaveIdsShowableToAnyAudience
      ).toHaveBeenCalledTimes(1);
      expect(
        [...connections.findWaveIdsShowableToAnyAudience.mock.calls[0][0]].sort(
          (a: string, b: string) => a.localeCompare(b)
        )
      ).toEqual([
        'quoted-subwave',
        'subwave-of-private-parent',
        'subwave-of-public-parent',
        'top-level-public'
      ]);
      expect(appWebSockets.send).toHaveBeenCalledTimes(2);
      for (const [sent] of appWebSockets.send.mock.calls) {
        const data = JSON.parse(sent.message).data;
        expect(data.mentioned_waves[0].wave.id).toBe('top-level-public');
        expect(data.mentioned_waves[1]).not.toHaveProperty('wave');
        expect(
          data.parts[0].quoted_drop.drop.mentioned_waves[0]
        ).not.toHaveProperty('wave');
        expect(data.reply_to.drop.mentioned_waves[0].wave.id).toBe(
          'subwave-of-public-parent'
        );
      }
    });

    it('omits all mentioned wave details when none can be confirmed', async () => {
      const { appWebSockets, notifier } = setup([]);

      await notifier.notifyAboutDropUpdate(rootDrop(), {});

      const data = JSON.parse(appWebSockets.send.mock.calls[0][0].message).data;
      for (const mention of data.mentioned_waves) {
        expect(mention).not.toHaveProperty('wave');
      }
    });

    it('skips the lookup when no mentioned wave carries details', async () => {
      const { connections, notifier } = setup([]);
      const drop = rootDrop();
      drop.mentioned_waves = [];
      drop.parts[0].quoted_drop = null;
      drop.reply_to = undefined;

      await notifier.notifyAboutDropUpdate(drop, {});

      expect(
        connections.findWaveIdsShowableToAnyAudience
      ).not.toHaveBeenCalled();
    });
  });
});
