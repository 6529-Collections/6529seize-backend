import {
  e2eeGroupEventPayload,
  WsE2eeEventPublisher
} from '@/api/e2ee/e2ee-events';
import { ApiE2eeLogItem } from '@/api/generated/models/ApiE2eeLogItem';
import { E2eeDb } from '@/e2ee/e2ee.db';

function item(data: string): ApiE2eeLogItem {
  return {
    seq: 7,
    type: 'message' as never,
    epoch: 2,
    kind: null,
    data,
    entry_hash: null,
    epoch_commitment: null,
    next_commit_key: null,
    signature: null,
    roster_add: [],
    roster_remove: [],
    epoch_fp: '0123456789abcdef',
    created_at: 1
  };
}

describe('E2EE websocket events', () => {
  it('inlines items up to 16 KiB and keeps frames small', () => {
    const small = e2eeGroupEventPayload({
      group: '0xg',
      seq: 7,
      epoch: 2,
      type: 'message',
      item: item('A'.repeat(1000))
    });
    expect(small).toHaveProperty('item');
    const large = e2eeGroupEventPayload({
      group: '0xg',
      seq: 7,
      epoch: 2,
      type: 'message',
      item: item('A'.repeat(17 * 1024))
    });
    expect(large).toEqual({ group: '0xg', seq: 7, epoch: 2, type: 'message' });
    expect(
      Buffer.byteLength(
        JSON.stringify({ type: 'E2EE_GROUP_EVENT', data: small })
      )
    ).toBeLessThan(28 * 1024);
  });

  it('sends hints to every primary connection and never throws', async () => {
    const sent: { connectionId: string; message: string }[] = [];
    const publisher = new WsE2eeEventPublisher(
      { claimPushWakes: jest.fn(async () => ['p1']) } as unknown as E2eeDb,
      async () => [
        { connectionId: 'c1', identityId: 'p1' },
        { connectionId: 'c2', identityId: 'p2' }
      ],
      async (connectionId, message) => {
        if (connectionId === 'c2') throw new Error('gone');
        sent.push({ connectionId, message });
      },
      jest.fn(async () => undefined)
    );
    await publisher.deviceRevoked(['p1', 'p2', 'p1'], {
      profile_id: 'p1',
      device_key: '0xd'
    });
    expect(sent).toEqual([
      {
        connectionId: 'c1',
        message: JSON.stringify({
          type: 'E2EE_DEVICE_REVOKED',
          data: { profile_id: 'p1', device_key: '0xd' }
        })
      }
    ]);
    await publisher.welcomes([
      { profileId: 'p1', deviceKey: '0xd', welcomeId: '0xw', group: '0xg' }
    ]);
    expect(JSON.parse(sent[1].message)).toEqual({
      type: 'E2EE_WELCOME',
      data: { device_key: '0xd', welcome_id: '0xw', group: '0xg' }
    });
    const failing = new WsE2eeEventPublisher(
      {
        claimPushWakes: jest.fn(async () => {
          throw new Error('db down');
        })
      } as unknown as E2eeDb,
      async () => {
        throw new Error('db down');
      },
      async () => undefined,
      jest.fn(async () => undefined)
    );
    await expect(
      failing.groupEvent(['p1'], {
        group: '0xg',
        seq: 1,
        epoch: 0,
        type: 'entry'
      })
    ).resolves.toBeUndefined();
    await expect(
      failing.wake('0xg', ['p1'], 'message')
    ).resolves.toBeUndefined();
  });

  it('enqueues wakes only for profiles past the throttle', async () => {
    const enqueue = jest.fn(async () => undefined);
    const claimPushWakes = jest.fn(async () => ['p2']);
    const publisher = new WsE2eeEventPublisher(
      { claimPushWakes } as unknown as E2eeDb,
      async () => [],
      async () => undefined,
      enqueue,
      () => 42
    );
    await publisher.wake('0xg', ['p1', 'p2'], 'added');
    expect(claimPushWakes).toHaveBeenCalledWith('0xg', ['p1', 'p2'], 42);
    expect(enqueue).toHaveBeenCalledWith(['p2'], 'added');
    await publisher.wake('0xg', [], 'added');
    expect(claimPushWakes).toHaveBeenCalledTimes(1);
  });

  it('releases the throttle slot when the wake was not queued', async () => {
    for (const enqueue of [
      jest.fn(async () => false),
      jest.fn(async () => {
        throw new Error('sqs down');
      })
    ]) {
      const releasePushWakes = jest.fn(async () => undefined);
      const publisher = new WsE2eeEventPublisher(
        {
          claimPushWakes: jest.fn(async () => ['p1']),
          releasePushWakes
        } as unknown as E2eeDb,
        async () => [],
        async () => undefined,
        enqueue,
        () => 42
      );
      await expect(
        publisher.wake('0xg', ['p1'], 'message')
      ).resolves.toBeUndefined();
      expect(releasePushWakes).toHaveBeenCalledWith('0xg', ['p1'], 42);
    }
  });

  it('keeps the slot once the wake is queued', async () => {
    const releasePushWakes = jest.fn(async () => undefined);
    const publisher = new WsE2eeEventPublisher(
      {
        claimPushWakes: jest.fn(async () => ['p1']),
        releasePushWakes
      } as unknown as E2eeDb,
      async () => [],
      async () => undefined,
      jest.fn(async () => true),
      () => 42
    );
    await publisher.wake('0xg', ['p1'], 'message');
    expect(releasePushWakes).not.toHaveBeenCalled();
  });
});
