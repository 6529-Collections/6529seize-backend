import { DeployerDropper } from '@/deployer-dropper';
import { MEMES_DEPLOYER } from '@/constants';
import { DropType } from '@/entities/IDrop';

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
        bypassChatLinkRestrictions: true,
        bypassChatSlowModeRestrictions: true
      }
    );
  });
});
