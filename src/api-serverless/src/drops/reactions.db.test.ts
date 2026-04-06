import 'reflect-metadata';
import { DROP_REACTIONS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ReactionsDb } from '@/api/drops/reactions.db';

describeWithSeed(
  'ReactionsDb',
  {
    table: DROP_REACTIONS_TABLE,
    rows: []
  },
  () => {
    const repo = new ReactionsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    async function getRows() {
      return await sqlExecutor.execute<{
        profile_id: string;
        drop_id: string;
        wave_id: string;
        reaction: string;
      }>(
        `
          SELECT profile_id, drop_id, wave_id, reaction
          FROM ${DROP_REACTIONS_TABLE}
          ORDER BY id ASC
        `
      );
    }

    async function seedReaction({
      profileId,
      dropId,
      waveId,
      reaction,
      createdAt
    }: {
      profileId: string;
      dropId: string;
      waveId: string;
      reaction: string;
      createdAt: string;
    }) {
      await sqlExecutor.execute(
        `
          INSERT INTO ${DROP_REACTIONS_TABLE}
            (profile_id, drop_id, wave_id, reaction, created_at)
          VALUES
            (:profileId, :dropId, :waveId, :reaction, :createdAt)
        `,
        { profileId, dropId, waveId, reaction, createdAt }
      );
    }

    it('inserts a new reaction', async () => {
      const changed = await repo.addReaction(
        'profile-1',
        'drop-1',
        'wave-1',
        ':+1:',
        ctx
      );

      expect(changed).toBe(true);
      await expect(getRows()).resolves.toEqual([
        {
          profile_id: 'profile-1',
          drop_id: 'drop-1',
          wave_id: 'wave-1',
          reaction: ':+1:'
        }
      ]);
    });

    it('treats an identical retry as a no-op', async () => {
      await seedReaction({
        profileId: 'profile-1',
        dropId: 'drop-1',
        waveId: 'wave-1',
        reaction: ':+1:',
        createdAt: '2000-01-01 00:00:00'
      });

      const changed = await repo.addReaction(
        'profile-1',
        'drop-1',
        'wave-1',
        ':+1:',
        ctx
      );

      expect(changed).toBe(false);
      await expect(getRows()).resolves.toEqual([
        {
          profile_id: 'profile-1',
          drop_id: 'drop-1',
          wave_id: 'wave-1',
          reaction: ':+1:'
        }
      ]);
    });

    it('updates the row when the reaction changes', async () => {
      await seedReaction({
        profileId: 'profile-1',
        dropId: 'drop-1',
        waveId: 'wave-1',
        reaction: ':+1:',
        createdAt: '2000-01-01 00:00:00'
      });

      const changed = await repo.addReaction(
        'profile-1',
        'drop-1',
        'wave-1',
        ':white_check_mark:',
        ctx
      );

      expect(changed).toBe(true);
      await expect(getRows()).resolves.toEqual([
        {
          profile_id: 'profile-1',
          drop_id: 'drop-1',
          wave_id: 'wave-1',
          reaction: ':white_check_mark:'
        }
      ]);
    });

    it('deletes an existing reaction', async () => {
      await seedReaction({
        profileId: 'profile-1',
        dropId: 'drop-1',
        waveId: 'wave-1',
        reaction: ':+1:',
        createdAt: '2000-01-01 00:00:00'
      });

      const removed = await repo.removeReaction(
        'profile-1',
        'drop-1',
        'wave-1',
        ctx
      );

      expect(removed).toBe(true);
      await expect(getRows()).resolves.toEqual([]);
    });

    it('treats a duplicate delete as a no-op', async () => {
      const removed = await repo.removeReaction(
        'profile-1',
        'drop-1',
        'wave-1',
        ctx
      );

      expect(removed).toBe(false);
      await expect(getRows()).resolves.toEqual([]);
    });
  }
);
