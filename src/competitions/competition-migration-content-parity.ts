import { createHash } from 'node:crypto';
import { DROPS_TABLE, COMPETITION_ENTRIES_TABLE } from '@/constants';
import { DropEntity } from '@/entities/IDrop';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { CompetitionEntryRepository } from './competition-entry.repository';
import { competitionPayloadHash } from './competition-command-identity';
import { legacyCompetitionEntryId } from './competition-id';

/** Baseline reconstructs source content; candidate reads its native version.
 * Persist hashes only: media, identity nominations and signatures stay private. */
export async function compareMigrationContent(
  db: SqlExecutor,
  id: string,
  waveId: string,
  ctx: RequestContext
) {
  const repository = new CompetitionEntryRepository(() => db);
  const baseline = createHash('sha256');
  const candidate = createHash('sha256');
  let cursor = '';
  let count = 0;
  while (true) {
    const drops = await db.execute<DropEntity>(
      `select * from ${DROPS_TABLE} where wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER') and id>:cursor order by id limit 100`,
      { waveId, cursor },
      { wrappedConnection: ctx.connection }
    );
    for (const drop of drops) {
      const entryId = legacyCompetitionEntryId(id, drop.id);
      baseline.update(
        competitionPayloadHash({
          entryId,
          content: await repository.loadDropContent(drop, ctx)
        })
      );
      candidate.update(
        competitionPayloadHash({
          entryId,
          content: await repository.getContent(entryId, ctx)
        })
      );
    }
    count += drops.length;
    if (drops.length < 100) break;
    cursor = drops[drops.length - 1].id;
  }
  const extra = await db.oneOrNull<{ count: number }>(
    `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id and status in ('ACTIVE','WINNER')`,
    { id },
    { wrappedConnection: ctx.connection }
  );
  return [
    {
      category: 'native_entry_content',
      baselineHash: competitionPayloadHash({
        count,
        content: baseline.digest('hex')
      }),
      candidateHash: competitionPayloadHash({
        count: Number(extra?.count ?? 0),
        content: candidate.digest('hex')
      })
    }
  ];
}
