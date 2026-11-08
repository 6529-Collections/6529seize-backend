import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { ANON_USER_ID } from '@/api/ws/ws';
import {
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WS_CONNECTIONS_TABLE,
  XTDH_STATS_META_TABLE
} from '@/constants';
import {
  WSConnectionEntity,
  WsConnectionPurpose
} from '@/entities/IWSConnection';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';

/**
 * Waves 1.3 (D3): with WS_AUDIENCE_FOLLOWERS on, a wave's frames reach
 * sockets with the wave open, its followers' sockets and DM members, within
 * today's visibility. With it off, nothing changes.
 */

const follower = anIdentity({ level_raw: 0, tdh: 20 });
const nonFollower = anIdentity({ level_raw: 0, tdh: 20 });
const viewer = anIdentity({ level_raw: 0, tdh: 20 });
const subwaveFollower = anIdentity({ level_raw: 0, tdh: 20 });
const everyone = aUserGroup({ level_min: 0 });

const publicWave = aWave({ visibility_group_id: null });
const subwave = aWave({
  visibility_group_id: null,
  parent_wave_id: publicWave.id
} as never);
const otherWave = aWave({ visibility_group_id: null });
const groupWave = aWave({ visibility_group_id: everyone.id });
const dmWave = aWave({
  visibility_group_id: everyone.id,
  is_direct_message: true
} as never);

function socket(
  connectionId: string,
  identityId: string,
  waveId: string | null,
  purpose: WsConnectionPurpose | null = null,
  openWaveId: string | null = null
): WSConnectionEntity {
  return {
    connection_id: connectionId,
    identity_id: identityId,
    wave_id: waveId,
    jwt_expiry: 4102444800,
    purpose,
    open_wave_id: openWaveId
  };
}

function follows(subscriberId: string, waveId: string) {
  return {
    subscriber_id: subscriberId,
    target_id: waveId,
    target_type: ActivityEventTargetType.WAVE,
    target_action: ActivityEventAction.DROP_CREATED,
    wave_id: waveId,
    subscribed_to_all_drops: false
  };
}

const ids = (rows: { connectionId: string }[]) =>
  rows.map((row) => row.connectionId).sort((a, b) => a.localeCompare(b));

describeWithSeed(
  'Follower audience (waves 1.3)',
  [
    withIdentities([follower, nonFollower, viewer, subwaveFollower]),
    withUserGroups([everyone]),
    withWaves([publicWave, subwave, otherWave, groupWave, dmWave]),
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        follows(follower.profile_id!, publicWave.id),
        follows(follower.profile_id!, groupWave.id),
        follows(subwaveFollower.profile_id!, subwave.id)
      ]
    },
    {
      table: WS_CONNECTIONS_TABLE,
      rows: [
        socket('follower-closed', follower.profile_id!, null),
        socket('follower-elsewhere', follower.profile_id!, otherWave.id),
        socket('nonfollower-closed', nonFollower.profile_id!, null),
        socket('nonfollower-open', viewer.profile_id!, publicWave.id),
        socket('anonymous-closed', ANON_USER_ID, null),
        socket('anonymous-open', ANON_USER_ID, publicWave.id),
        socket('subwave-follower-closed', subwaveFollower.profile_id!, null),
        socket(
          'typing-open',
          viewer.profile_id!,
          publicWave.id,
          WsConnectionPurpose.TYPING
        ),
        socket('group-viewer', viewer.profile_id!, groupWave.id),
        socket('dm-viewer', viewer.profile_id!, dmWave.id),
        // An app socket (not subscribed to any wave) that declared, with
        // SET_OPEN_WAVE, that its tab has the public wave open.
        socket('app-open', nonFollower.profile_id!, null, null, publicWave.id)
      ]
    },
    {
      table: XTDH_STATS_META_TABLE,
      rows: [
        {
          id: 1,
          active_slot: 'a',
          as_of_midnight_ms: 0,
          last_updated_at: new Date(0)
        }
      ]
    }
  ],
  () => {
    const repo = new WsConnectionRepository(
      () => sqlExecutor,
      new UserGroupsService(
        new UserGroupsDb(() => sqlExecutor),
        mock(),
        mock()
      ),
      () => false
    );
    const env = process.env.WS_AUDIENCE_FOLLOWERS;
    const withFlag = (on: boolean) => {
      if (on) process.env.WS_AUDIENCE_FOLLOWERS = 'true';
      else delete process.env.WS_AUDIENCE_FOLLOWERS;
    };
    const recipients = (waveId: string, system = false) =>
      (system
        ? repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
            { waveId, groupId: null },
            {}
          )
        : repo.getCurrentlyOnlineCommunityMemberConnectionIds(
            { waveId, groupId: null },
            {}
          )
      ).then(ids);

    afterEach(() => {
      if (env === undefined) delete process.env.WS_AUDIENCE_FOLLOWERS;
      else process.env.WS_AUDIENCE_FOLLOWERS = env;
    });

    it('keeps today’s public audience with the flag off', async () => {
      withFlag(false);
      expect(await recipients(publicWave.id)).toEqual([
        'anonymous-closed',
        'anonymous-open',
        'app-open',
        'follower-closed',
        'nonfollower-closed',
        'nonfollower-open',
        'subwave-follower-closed'
      ]);
      // A declared open wave never narrows an app socket: with the flag
      // off it still gets every other public wave, as today.
      expect(await recipients(otherWave.id)).toContain('app-open');
    });

    it('treats an app socket’s declared open wave as viewing it with the flag on', async () => {
      withFlag(true);
      expect(await recipients(publicWave.id)).toContain('app-open');
      // A wave it neither has open nor follows.
      expect(await recipients(otherWave.id)).not.toContain('app-open');
    });

    it.each([false, true])(
      'narrows a public wave to viewers and followers with the flag on (system=%s)',
      async (system) => {
        withFlag(true);
        expect(await recipients(publicWave.id, system)).toEqual([
          // Anyone with the wave open, signed in or not.
          'anonymous-open',
          'app-open',
          // A follower with the wave closed.
          'follower-closed',
          'nonfollower-open',
          // Following a subwave lists the parent wave too.
          'subwave-follower-closed'
        ]);
        // Left out: a non-follower with the wave closed, anonymous sockets
        // without it open, a follower viewing another wave (as today) and
        // the typing socket.
      }
    );

    it('sends a subwave’s frames to followers of the subwave and of its parent', async () => {
      withFlag(true);
      expect(await recipients(subwave.id)).toEqual([
        'follower-closed',
        'subwave-follower-closed'
      ]);
    });

    it('narrows a group wave to members who follow it or have it open', async () => {
      withFlag(false);
      const before = await recipients(groupWave.id);
      withFlag(true);
      const after = await recipients(groupWave.id);

      expect(after).toEqual([
        'follower-closed',
        'follower-elsewhere',
        'group-viewer'
      ]);
      // Never wider than today's visibility.
      expect(after.every((id) => before.includes(id))).toBe(true);
      expect(before).toContain('nonfollower-closed');
    });

    it('keeps every DM member in the audience', async () => {
      withFlag(false);
      const before = await recipients(dmWave.id);
      withFlag(true);
      expect(await recipients(dmWave.id)).toEqual(before);
      expect(before).toContain('nonfollower-closed');
    });

    it('leaves typing broadcasts to their own rules', async () => {
      const typing = () =>
        repo
          .getCurrentlyOnlineCommunityMemberConnectionIds(
            { waveId: publicWave.id, groupId: null },
            {},
            { includeTypingSockets: true }
          )
          .then(ids);
      withFlag(false);
      const before = await typing();
      withFlag(true);
      expect(await typing()).toEqual(before);
      expect(before).toContain('typing-open');
    });
  }
);
