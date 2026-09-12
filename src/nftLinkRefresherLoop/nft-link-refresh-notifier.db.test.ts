import { WS_CONNECTIONS_TABLE } from '@/constants/db-tables';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { NftLinkRefreshNotifierDb } from '@/nftLinkRefresherLoop/nft-link-refresh-notifier.db';
import { ANON_USER_ID } from '@/api/ws/ws';

describeWithSeed(
  'NFT link notification recipients',
  {
    table: WS_CONNECTIONS_TABLE,
    rows: [
      { connection_id: 'expired', identity_id: 'old', jwt_expiry: 1 },
      {
        connection_id: 'active',
        identity_id: 'one',
        jwt_expiry: 4_000_000_000
      },
      {
        connection_id: 'active',
        identity_id: 'two',
        jwt_expiry: 4_000_000_001
      },
      {
        connection_id: 'anonymous',
        identity_id: ANON_USER_ID,
        jwt_expiry: 4_000_000_000
      }
    ]
  },
  () => {
    it('excludes expired clients and emits each active connection once, including anonymous clients', async () => {
      const db = new NftLinkRefreshNotifierDb(() => sqlExecutor);
      const recipients = await db.findActiveRecipients({});
      expect(recipients).toHaveLength(2);
      expect(recipients).toEqual(
        expect.arrayContaining([
          { connection_id: 'active', jwt_expiry: 4_000_000_001 },
          { connection_id: 'anonymous', jwt_expiry: 4_000_000_000 }
        ])
      );
    });
  }
);
