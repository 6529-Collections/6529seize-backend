import 'reflect-metadata';
import {
  DROP_QUICKVOTE_SKIPS_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE
} from '@/constants';
import { DropType, DropEntity } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { WaveQuickVoteDb } from './wave-quick-vote.db';

const repo = new WaveQuickVoteDb(() => sqlExecutor);
const ctx: RequestContext = {};

function aDrop(
  params: Partial<DropEntity>,
  key: { id: string; serial_no: number; wave_id: string }
): DropEntity {
  return {
    serial_no: key.serial_no,
    id: key.id,
    wave_id: key.wave_id,
    author_id: params.author_id ?? 'author-1',
    created_at: params.created_at ?? 0,
    updated_at: params.updated_at ?? null,
    title: params.title ?? null,
    parts_count: params.parts_count ?? 1,
    reply_to_drop_id: params.reply_to_drop_id ?? null,
    reply_to_part_id: params.reply_to_part_id ?? null,
    drop_type: params.drop_type ?? DropType.PARTICIPATORY,
    signature: params.signature ?? null,
    hide_link_preview: params.hide_link_preview ?? false
  };
}

describeWithSeed(
  'WaveQuickVoteDb',
  [
    {
      table: DROPS_TABLE,
      rows: [
        aDrop(
          {
            created_at: 100
          },
          { id: 'drop-voted', serial_no: 1, wave_id: 'wave-1' }
        ),
        aDrop(
          {
            created_at: 200
          },
          { id: 'drop-oldest-eligible', serial_no: 2, wave_id: 'wave-1' }
        ),
        aDrop(
          {
            created_at: 300
          },
          { id: 'drop-newer-eligible', serial_no: 3, wave_id: 'wave-1' }
        ),
        aDrop(
          {
            created_at: 50,
            drop_type: DropType.CHAT
          },
          { id: 'drop-chat', serial_no: 4, wave_id: 'wave-1' }
        )
      ]
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: [
        {
          voter_id: 'identity-1',
          drop_id: 'drop-voted',
          votes: 1,
          wave_id: 'wave-1'
        }
      ]
    },
    {
      table: DROP_QUICKVOTE_SKIPS_TABLE,
      rows: []
    }
  ],
  () => {
    it('returns the newest participatory drop that is neither voted nor skipped', async () => {
      const result = await repo.findNextUndiscoveredDrop(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        ctx
      );

      expect(result?.id).toBe('drop-newer-eligible');
    });

    it('returns the undiscovered drop at the requested offset', async () => {
      const result = await repo.findUndiscoveredDropBySkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 1
        },
        ctx
      );

      expect(result?.id).toBe('drop-oldest-eligible');
    });

    it('counts all participatory drops where the identity has no vote', async () => {
      const result = await repo.countUnvotedDrops(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        ctx
      );

      expect(result).toBe(2);
    });

    it('does not return drops that were skipped by the same identity', async () => {
      await repo.insertSkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          drop_id: 'drop-newer-eligible'
        },
        ctx
      );

      const result = await repo.findNextUndiscoveredDrop(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        ctx
      );

      expect(result?.id).toBe('drop-oldest-eligible');

      const count = await repo.countUnvotedDrops(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        ctx
      );

      expect(count).toBe(2);
    });

    it('returns skipped unvoted drops ordered by earliest skipped time', async () => {
      await sqlExecutor.execute(
        `
          INSERT INTO ${DROP_QUICKVOTE_SKIPS_TABLE} (
            identity_id,
            wave_id,
            drop_id,
            skipped_at
          )
          VALUES
            ('identity-1', 'wave-1', 'drop-newer-eligible', 200),
            ('identity-1', 'wave-1', 'drop-oldest-eligible', 100)
        `
      );

      const firstResult = await repo.findSkippedUnvotedDropBySkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 0
        },
        ctx
      );
      const secondResult = await repo.findSkippedUnvotedDropBySkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 1
        },
        ctx
      );

      expect(firstResult?.id).toBe('drop-oldest-eligible');
      expect(secondResult?.id).toBe('drop-newer-eligible');
    });

    it('inserts skips idempotently', async () => {
      await repo.insertSkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          drop_id: 'drop-newer-eligible'
        },
        ctx
      );
      await repo.insertSkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          drop_id: 'drop-newer-eligible'
        },
        ctx
      );

      const count = await sqlExecutor
        .execute<{ cnt: number }>(
          `
            SELECT COUNT(*) as cnt
            FROM ${DROP_QUICKVOTE_SKIPS_TABLE}
            WHERE identity_id = :identity_id
              AND wave_id = :wave_id
              AND drop_id = :drop_id
          `,
          {
            identity_id: 'identity-1',
            wave_id: 'wave-1',
            drop_id: 'drop-newer-eligible'
          }
        )
        .then((rows) => rows[0]?.cnt ?? 0);

      expect(count).toBe(1);
    });

    it('clears skips only for the given identity and wave', async () => {
      await repo.insertSkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          drop_id: 'drop-newer-eligible'
        },
        ctx
      );
      await repo.insertSkip(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          drop_id: 'drop-oldest-eligible'
        },
        ctx
      );
      await repo.insertSkip(
        {
          identity_id: 'identity-2',
          wave_id: 'wave-1',
          drop_id: 'drop-newer-eligible'
        },
        ctx
      );

      await repo.clearSkips(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        ctx
      );

      const remaining = await sqlExecutor.execute<{
        identity_id: string;
        wave_id: string;
        drop_id: string;
      }>(
        `
          SELECT identity_id, wave_id, drop_id
          FROM ${DROP_QUICKVOTE_SKIPS_TABLE}
          ORDER BY identity_id ASC, wave_id ASC, drop_id ASC
        `
      );

      expect(remaining).toEqual([
        {
          identity_id: 'identity-2',
          wave_id: 'wave-1',
          drop_id: 'drop-newer-eligible'
        }
      ]);
    });
  }
);
