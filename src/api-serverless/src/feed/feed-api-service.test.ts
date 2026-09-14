import { FeedApiService } from './feed.api.service';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { dropsService } from '@/api/drops/drops.api.service';
import { waveApiService } from '@/api/waves/wave.api.service';

jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: { findDropsByIds: jest.fn() }
}));
jest.mock('@/api/waves/wave.api.service', () => ({
  waveApiService: { findWavesByIdsOrThrow: jest.fn() }
}));

describe('Feed visibility hydration', () => {
  afterEach(() => jest.clearAllMocks());

  it.each([
    { action: ActivityEventAction.DROP_REPLIED, readable: [], expected: 0 },
    {
      action: ActivityEventAction.DROP_REPLIED,
      readable: ['reply'],
      expected: 0
    },
    {
      action: ActivityEventAction.DROP_REPLIED,
      readable: ['parent'],
      expected: 0
    },
    {
      action: ActivityEventAction.DROP_REPLIED,
      readable: ['parent', 'reply'],
      expected: 1
    },
    {
      action: ActivityEventAction.DROP_CREATED,
      readable: ['reply'],
      expected: 0
    },
    {
      action: ActivityEventAction.DROP_CREATED,
      readable: ['parent', 'reply'],
      expected: 1
    },
    { action: ActivityEventAction.WAVE_CREATED, readable: [], expected: 0 }
  ])(
    'omits partial feed entries: $action / $readable',
    async ({ action, readable, expected }) => {
      const drops = Object.fromEntries(
        readable.map((id) => [
          id,
          { id, reply_to: id === 'reply' ? { drop_id: 'parent' } : null }
        ])
      );
      jest
        .mocked(dropsService.findDropsByIds)
        .mockResolvedValue(drops as never);
      jest.mocked(waveApiService.findWavesByIdsOrThrow).mockResolvedValue({});
      const service = new FeedApiService(
        {
          getNextActivityEvents: jest.fn().mockResolvedValue([
            {
              id: 1,
              action,
              target_type: ActivityEventTargetType.DROP,
              target_id: 'parent',
              data: JSON.stringify({
                drop_id:
                  action === ActivityEventAction.DROP_CREATED
                    ? 'reply'
                    : 'parent',
                reply_id: 'reply',
                wave_id: 'wave'
              })
            }
          ])
        } as never,
        { getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]) } as never
      );
      const items = await service.getFeed({ serial_no_less_than: null }, {
        getActingAsId: () => 'reader',
        isAuthenticatedAsProxy: () => false
      } as never);
      expect(items).toHaveLength(expected);
      if (expected) {
        expect(items[0].item).toEqual({
          drop: drops.parent,
          reply: drops.reply
        });
      }
    }
  );
});
