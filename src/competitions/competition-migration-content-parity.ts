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
  const drops = await db.execute<DropEntity>(
    `select * from ${DROPS_TABLE} where wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER') order by id limit 1001`,
    { waveId },
    { wrappedConnection: ctx.connection }
  );
  if (drops.length > 1000)
    throw new Error(
      'OWNED_EXCEPTION: full native content comparison exceeds bounded ordinary cohort'
    );
  const repository = new CompetitionEntryRepository(() => db);
  const baseline = [],
    candidate = [];
  for (const drop of drops) {
    const entryId = legacyCompetitionEntryId(id, drop.id);
    baseline.push({
      entryId,
      hash: competitionPayloadHash(await repository.loadDropContent(drop, ctx))
    });
    candidate.push({
      entryId,
      hash: competitionPayloadHash(await repository.getContent(entryId, ctx))
    });
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
        count: drops.length,
        content: baseline
      }),
      candidateHash: competitionPayloadHash({
        count: Number(extra?.count ?? 0),
        content: candidate
      })
    }
  ];
}
