import fc from 'fast-check';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import {
  getQuotedDropIds,
  redactQuotedDropsOutsideAudience,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';

function aDropWithoutWave(id: string, content: string, quotedDrop?: any): any {
  return {
    id,
    serial_no: 1,
    drop_type: ApiDropType.Chat,
    author: { id: `${id}-author`, subscribed_actions: [] },
    moderation: { status: 'VISIBLE', can_view: true },
    parts: [
      {
        part_id: 1,
        content,
        media: [],
        attachments: [],
        quoted_drop: quotedDrop ?? null
      }
    ]
  };
}

function aQuote(drop: any): any {
  return { drop_id: drop.id, drop_part_id: 1, is_deleted: false, drop };
}

function aRootDrop(quotedDrop: any, replyToDrop?: any): any {
  return {
    ...aDropWithoutWave('root', 'root content', quotedDrop),
    reply_to: replyToDrop
      ? {
          drop_id: replyToDrop.id,
          drop_part_id: 1,
          is_deleted: false,
          drop: replyToDrop
        }
      : undefined,
    wave: {
      id: 'root-wave',
      visibility_group_id: null,
      voting_credit_type: ApiWaveCreditType.Tdh,
      voting_credit_scope: ApiWaveCreditScope.Wave
    }
  };
}

describe('redactQuotedDropsOutsideAudience', () => {
  it('returns the same payload when every quote is visible to the audience', () => {
    const drop = aRootDrop(aQuote(aDropWithoutWave('quoted', 'shared')));

    expect(redactQuotedDropsOutsideAudience(drop, new Set(['quoted']))).toBe(
      drop
    );
  });

  it('keeps only the reference for quotes outside the audience', () => {
    const nested = aDropWithoutWave('nested', 'nested content');
    const visible = aDropWithoutWave('visible', 'visible', aQuote(nested));
    const replyQuoted = aDropWithoutWave('reply-quoted', 'reply quote');
    const reply = aDropWithoutWave('reply', 'reply', aQuote(replyQuoted));
    const drop = aRootDrop(aQuote(visible), reply);

    const result = redactQuotedDropsOutsideAudience(drop, new Set(['visible']));

    expect(result.parts[0].quoted_drop?.drop?.id).toBe('visible');
    expect(result.parts[0].quoted_drop?.drop?.parts[0].quoted_drop).toEqual({
      drop_id: 'nested',
      drop_part_id: 1,
      is_deleted: false
    });
    expect(result.reply_to?.drop?.parts[0].quoted_drop).toEqual({
      drop_id: 'reply-quoted',
      drop_part_id: 1,
      is_deleted: false
    });
    expect(JSON.stringify(result)).not.toContain('nested content');
    expect(JSON.stringify(result)).not.toContain('reply quote');
    expect(drop.parts[0].quoted_drop.drop.parts[0].quoted_drop.drop.id).toBe(
      'nested'
    );
  });

  it('never leaves an embedded quote outside the visible set', () => {
    const ids = ['a', 'b', 'c', 'd'];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(ids, { minLength: 1 }),
        fc.subarray(ids),
        (chainIds, visibleIds) => {
          let quote: any = undefined;
          for (const id of [...chainIds].reverse()) {
            quote = aQuote(aDropWithoutWave(id, `content-${id}`, quote));
          }
          const visibleSet = new Set(visibleIds);
          const result = redactQuotedDropsOutsideAudience(
            aRootDrop(quote),
            visibleSet
          );
          const embeddedIds: string[] = [];
          let current = result.parts[0].quoted_drop?.drop;
          while (current) {
            embeddedIds.push(current.id);
            current = current.parts[0].quoted_drop?.drop;
          }
          expect(embeddedIds.every((id) => visibleSet.has(id))).toBe(true);
          expect(getQuotedDropIds(result).length).toBeGreaterThan(0);
        }
      )
    );
  });
});

describe('WsListenersNotifier quoted drop audience', () => {
  function createNotifier(visibleQuotedDropIds: string[]) {
    const appWebSockets = { send: jest.fn().mockResolvedValue(undefined) };
    const wsConnectionRepository = {
      getCurrentlyOnlineCommunityMemberConnectionIds: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', profileId: 'profile-1' },
          { connectionId: 'connection-anon', profileId: null }
        ]),
      findDropIdsReadableByWaveAudience: jest
        .fn()
        .mockResolvedValue(new Set(visibleQuotedDropIds))
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any,
      { getViewerContextsForDrop: jest.fn().mockResolvedValue({}) }
    );
    return { notifier, appWebSockets, wsConnectionRepository };
  }

  it.each([
    'notifyAboutDropUpdate',
    'notifyAboutDropRatingUpdate',
    'notifyAboutDropReactionUpdate'
  ] as const)(
    'omits unreadable quotes from direct %s payloads',
    async (method) => {
      const { notifier, appWebSockets, wsConnectionRepository } =
        createNotifier([]);
      const drop = aRootDrop(
        aQuote(aDropWithoutWave('quoted', 'restricted content'))
      );

      await notifier[method](drop, {});

      expect(
        wsConnectionRepository.findDropIdsReadableByWaveAudience
      ).toHaveBeenCalledWith({ waveId: 'root-wave', dropIds: ['quoted'] }, {});
      expect(appWebSockets.send).toHaveBeenCalledTimes(2);
      for (const [{ message }] of appWebSockets.send.mock.calls) {
        expect(message).not.toContain('restricted content');
        expect(JSON.parse(message).data.parts[0].quoted_drop).toEqual({
          drop_id: 'quoted',
          drop_part_id: 1,
          is_deleted: false
        });
      }
    }
  );

  it.each([
    'notifyAboutDropUpdate',
    'notifyAboutDropRatingUpdate',
    'notifyAboutDropReactionUpdate'
  ] as const)(
    'redacts legacy %s fan-out and wakes capable delivery once',
    async (method) => {
      const previousEnvironment = process.env.NODE_ENV;
      process.env.NODE_ENV = 'staging';
      try {
        const { appWebSockets, wsConnectionRepository } = createNotifier([]);
        const repository = {
          ...wsConnectionRepository,
          filterConnectionIdsByDeliveryMode: jest
            .fn()
            .mockResolvedValue(['connection-anon'])
        };
        const wake = jest.fn().mockResolvedValue(undefined);
        const notifier = new WsListenersNotifier(
          appWebSockets as any,
          repository as any,
          { getViewerContextsForDrop: jest.fn().mockResolvedValue({}) },
          wake
        );
        const drop = aRootDrop(
          aQuote(aDropWithoutWave('quoted', 'restricted content'))
        );
        await notifier[method](drop, {});
        expect(wake).toHaveBeenCalledTimes(1);
        expect(appWebSockets.send).toHaveBeenCalledTimes(1);
        expect(appWebSockets.send).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionId: 'connection-anon',
            legacyOnly: true
          })
        );
        expect(appWebSockets.send.mock.calls[0][0].message).not.toContain(
          'restricted content'
        );
      } finally {
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
      }
    }
  );

  it('keeps quoted content the wave audience can read', async () => {
    const { notifier, appWebSockets } = createNotifier(['quoted']);
    const drop = aRootDrop(aQuote(aDropWithoutWave('quoted', 'shared quote')));

    await notifier.notifyAboutDropReactionUpdate(drop, {});

    expect(appWebSockets.send).toHaveBeenCalledTimes(2);
    for (const [{ message }] of appWebSockets.send.mock.calls) {
      expect(message).toContain('shared quote');
    }
  });

  it('skips the audience lookup for drops without quotes', async () => {
    const { notifier, wsConnectionRepository } = createNotifier([]);

    await notifier.notifyAboutDropRatingUpdate(aRootDrop(undefined), {});

    expect(
      wsConnectionRepository.findDropIdsReadableByWaveAudience
    ).not.toHaveBeenCalled();
  });
});
