import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import { ProfileProxiesDb } from './profile-proxies.db';
import { ProfileProxyActionType } from '../entities/IProfileProxyAction';
import {
  PROFILE_PROXIES_TABLE,
  PROFILE_PROXY_ACTIONS_TABLE
} from '@/constants';
import { Time } from '../time';

const PROXY_ID = 'proxy-1';
const GRANTOR = 'grantor-profile';
const GRANTEE = 'grantee-profile';

describeWithSeed(
  'ProfileProxiesDb wave_allowlist round trip',
  {
    table: PROFILE_PROXIES_TABLE,
    rows: [
      {
        id: PROXY_ID,
        target_id: GRANTEE,
        created_by: GRANTOR,
        created_at: Time.millis(1000).toMillis()
      }
    ]
  },
  () => {
    const db = new ProfileProxiesDb(() => sqlExecutor);

    async function insertAction(
      wave_allowlist: string[] | null,
      action_type = ProfileProxyActionType.CREATE_DROP_TO_WAVE
    ): Promise<string> {
      return db.executeNativeQueriesInTransaction(async (connection) => {
        const { actionId } = await db.insertProfileProxyAction({
          profileProxyAction: {
            proxy_id: PROXY_ID,
            action_type,
            credit_amount: null,
            credit_spent: null,
            start_time: Time.millis(1000).toMillis(),
            end_time: null,
            wave_allowlist
          },
          connection
        });
        return actionId;
      });
    }

    it('stores a scoped grant and reads it back as a string array everywhere', async () => {
      const actionId = await insertAction(['wave-1', 'wave-2']);

      const byId = await db.findProfileProxyActionById({ id: actionId });
      expect(byId?.wave_allowlist).toEqual(['wave-1', 'wave-2']);
      expect(byId?.is_active).toBe(false);

      const byType = await db.findProfileProxyActionsByProxyIdAndActionType({
        proxy_id: PROXY_ID,
        action_type: ProfileProxyActionType.CREATE_DROP_TO_WAVE
      });
      expect(byType.map((it) => it.wave_allowlist)).toEqual([
        ['wave-1', 'wave-2']
      ]);

      const byPair = await db.findProfileProxyGrantedActionsByGrantorAndGrantee(
        { grantor: GRANTOR, grantee: GRANTEE }
      );
      expect(byPair[0]?.wave_allowlist).toEqual(['wave-1', 'wave-2']);

      const received = await db.findProfileProxyReceivedActionsByProfileId({
        target_id: GRANTEE
      });
      expect(received[0]?.wave_allowlist).toEqual(['wave-1', 'wave-2']);

      const raw = await sqlExecutor.execute<{ wave_allowlist: unknown }>(
        `select wave_allowlist from ${PROFILE_PROXY_ACTIONS_TABLE} where id = :id`,
        { id: actionId }
      );
      expect(JSON.parse(String(raw[0].wave_allowlist))).toEqual([
        'wave-1',
        'wave-2'
      ]);
    });

    it('stores a legacy grant as NULL and reads it back as null', async () => {
      const actionId = await insertAction(null);
      const byId = await db.findProfileProxyActionById({ id: actionId });
      expect(byId?.wave_allowlist).toBeNull();
      const raw = await sqlExecutor.execute<{ wave_allowlist: unknown }>(
        `select wave_allowlist from ${PROFILE_PROXY_ACTIONS_TABLE} where id = :id`,
        { id: actionId }
      );
      expect(raw[0].wave_allowlist).toBeNull();
    });

    it('replaces the scope on update and leaves it alone when omitted', async () => {
      const actionId = await insertAction(['wave-1']);

      await db.updateProfileProxyAction({
        action_id: actionId,
        wave_allowlist: ['wave-3', 'wave-4']
      });
      expect(
        (await db.findProfileProxyActionById({ id: actionId }))?.wave_allowlist
      ).toEqual(['wave-3', 'wave-4']);

      await db.updateProfileProxyAction({
        action_id: actionId,
        end_time: Time.millis(5000).toMillis()
      });
      const after = await db.findProfileProxyActionById({ id: actionId });
      expect(after?.end_time).toBe(Time.millis(5000).toMillis());
      expect(after?.wave_allowlist).toEqual(['wave-3', 'wave-4']);

      await db.updateProfileProxyAction({
        action_id: actionId,
        credit_amount: 7,
        wave_allowlist: ['wave-5']
      });
      const both = await db.findProfileProxyActionById({ id: actionId });
      expect(Number(both?.credit_amount)).toBe(7);
      expect(both?.wave_allowlist).toEqual(['wave-5']);
    });

    it('is a no-op update when nothing is given', async () => {
      const actionId = await insertAction(['wave-1']);
      await db.updateProfileProxyAction({ action_id: actionId });
      expect(
        (await db.findProfileProxyActionById({ id: actionId }))?.wave_allowlist
      ).toEqual(['wave-1']);
    });

    it('decodes the scope on the active-actions query as well', async () => {
      const actionId = await insertAction(['wave-9']);
      await sqlExecutor.execute(
        `update ${PROFILE_PROXY_ACTIONS_TABLE} set accepted_at = :accepted_at, is_active = true where id = :id`,
        { id: actionId, accepted_at: Time.millis(2000).toMillis() }
      );
      const active = await db.findActiveProfileProxyActionsByProxyIds({
        proxy_ids: [PROXY_ID]
      });
      expect(active).toHaveLength(1);
      expect(active[0].wave_allowlist).toEqual(['wave-9']);
      expect(active[0].is_active).toBe(true);
    });
  }
);
