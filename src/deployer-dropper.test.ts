jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn()
}));
jest.mock('@/api/waves/wave-score.service', () => ({
  waveScoreService: { requestWaveScoreRefreshBestEffort: jest.fn() },
  WaveScoreDirtyRefreshReason: { DROP_CHANGED: 'DROP_CHANGED' }
}));

import { CommittedDropSignatures } from '@/api/device-signing/bot-device-signer';
import { DeployerDropper } from '@/deployer-dropper';
import { MEMES_DEPLOYER } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { setSqlExecutor } from '@/sql-executor';
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

  describe('with a device key for the deployer profile', () => {
    const signingDeployer = () =>
      signingBot({
        profileId: 'deployer-profile',
        otherWallets: { [MEMES_DEPLOYER.toLowerCase()]: 'deployer-profile' }
      });

    const twoDrops = () => ({
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
    });

    const signed = (events: { wave_id: string; drop_id: string | null }[]) =>
      events.map(({ wave_id, drop_id }) => ({ wave_id, drop_id }));

    it("signs the announcements of a caller's transaction after its commit", async () => {
      const { signer, store } = await signingDeployer();
      const createDrop = twoDrops();
      const dropper = new DeployerDropper(createDrop as any, signer);
      const signatures = new CommittedDropSignatures(signer);

      await expect(
        dropper.drop(
          { message: 'Mint is live', waves: ['wave-1', 'wave-2'] },
          { connection: {} as any },
          signatures
        )
      ).resolves.toEqual([1, 2]);
      // Still inside the caller's transaction: nothing stored yet.
      expect(store.events).toHaveLength(0);

      await signatures.signCommitted({});

      expect(createDrop.execute).toHaveBeenCalledTimes(2);
      expect(signed(store.events)).toEqual([
        { wave_id: 'wave-1', drop_id: 'drop-1' },
        { wave_id: 'wave-2', drop_id: 'drop-2' }
      ]);
      expect(store.events[0].profile_id).toBe('deployer-profile');
      expect(JSON.parse(store.events[0].body!)).toMatchObject({
        wave_id: 'wave-1',
        parts: [{ content: 'Mint is live' }],
        mentioned_users: []
      });
    });

    it("leaves nothing behind when the caller's transaction rolls back", async () => {
      const { signer, store } = await signingDeployer();
      const dropper = new DeployerDropper(twoDrops() as any, signer);
      const signatures = new CommittedDropSignatures(signer);
      const callerTransaction = async () => {
        await dropper.drop(
          { message: 'Mint is live', waves: ['wave-1', 'wave-2'] },
          { connection: {} as any },
          signatures
        );
        throw new Error('the done marker could not be written');
      };

      await expect(
        callerTransaction().then(() => signatures.signCommitted({}))
      ).rejects.toThrow('the done marker could not be written');

      expect(store.events).toHaveLength(0);
      expect(store.authorSignatures.size).toBe(0);
    });

    it('signs its own transaction after the commit', async () => {
      const { signer, store } = await signingDeployer();
      const order: string[] = [];
      setSqlExecutor({
        executeNativeQueriesInTransaction: async (work: any) => {
          const result = await work({ connection: 'tx' });
          order.push(`commit with ${store.events.length} events`);
          return result;
        }
      } as any);
      const dropper = new DeployerDropper(twoDrops() as any, signer);

      await dropper.drop(
        { message: 'Card is live', waves: ['wave-1', 'wave-2'] },
        {}
      );

      expect(order).toEqual(['commit with 0 events']);
      expect(signed(store.events)).toEqual([
        { wave_id: 'wave-1', drop_id: 'drop-1' },
        { wave_id: 'wave-2', drop_id: 'drop-2' }
      ]);
    });

    it("writes unsigned in a caller's transaction that signs nothing after", async () => {
      const { signer, store } = await signingDeployer();
      const dropper = new DeployerDropper(twoDrops() as any, signer);
      await dropper.drop(
        { message: 'Mint is live', waves: ['wave-1'] },
        { connection: {} as any }
      );
      expect(store.events).toHaveLength(0);
    });
  });
});
