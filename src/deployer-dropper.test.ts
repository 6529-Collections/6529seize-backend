import { DeployerDropper } from '@/deployer-dropper';
import { MEMES_DEPLOYER } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { signingBot } from '@/tests/fixtures/bot-device-signing.fixture';

describe('DeployerDropper', () => {
  it('bypasses chat link restrictions for deployer-created drops', async () => {
    const createDrop = {
      execute: jest
        .fn()
        .mockResolvedValue({ pending_push_notification_ids: [1, 2] })
    };
    const dropper = new DeployerDropper(createDrop as any);

    await expect(
      dropper.drop(
        {
          message: 'Mint is live https://example.com',
          mentionedUsers: ['artist'],
          waves: ['wave-1']
        },
        { connection: {} as any }
      )
    ).resolves.toEqual([1, 2]);

    expect(createDrop.execute).toHaveBeenCalledWith(
      {
        drop_id: null,
        wave_id: 'wave-1',
        reply_to: null,
        title: null,
        parts: [
          {
            content: 'Mint is live https://example.com',
            quoted_drop: null,
            media: []
          }
        ],
        referenced_nfts: [],
        mentioned_users: [{ handle: 'artist' }],
        mentioned_waves: [],
        metadata: [],
        author_identity: MEMES_DEPLOYER,
        drop_type: DropType.CHAT,
        is_additional_action_promised: null,
        mentioned_groups: [],
        signature: null
      },
      false,
      {
        timer: undefined,
        connection: {},
        prePublication: { trustedSystem: true },
        bypassChatLinkRestrictions: true,
        bypassChatSlowModeRestrictions: true
      }
    );
  });

  it('signs each announcement when the deployer profile has a device key', async () => {
    const { signer, store } = await signingBot({
      profileId: 'deployer-profile',
      otherWallets: { [MEMES_DEPLOYER.toLowerCase()]: 'deployer-profile' }
    });
    const createDrop = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({
          drop_id: 'drop-1',
          pending_push_notification_ids: [1]
        })
        .mockResolvedValueOnce({
          drop_id: 'drop-2',
          pending_push_notification_ids: [2]
        })
    };
    const dropper = new DeployerDropper(createDrop as any, signer);

    await expect(
      dropper.drop(
        { message: 'Mint is live', waves: ['wave-1', 'wave-2'] },
        { connection: {} as any }
      )
    ).resolves.toEqual([1, 2]);

    expect(createDrop.execute).toHaveBeenCalledTimes(2);
    expect(
      store.events.map(({ wave_id, drop_id, profile_id }) => ({
        wave_id,
        drop_id,
        profile_id
      }))
    ).toEqual([
      { wave_id: 'wave-1', drop_id: 'drop-1', profile_id: 'deployer-profile' },
      { wave_id: 'wave-2', drop_id: 'drop-2', profile_id: 'deployer-profile' }
    ]);
    expect(JSON.parse(store.events[0].body!)).toMatchObject({
      wave_id: 'wave-1',
      parts: [{ content: 'Mint is live' }],
      mentioned_users: []
    });
  });
});
