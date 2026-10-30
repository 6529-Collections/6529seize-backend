import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  IDENTITY_MUTES_TABLE,
  WAVE_READER_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { competitionEntryVisibleSql } from '@/competitions/competition-entry-visibility';
import { NativeCompetitionEvent } from '@/competitions/native-competition-runtime.repository';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { waveReadAccessSql } from '@/waves/wave-read-access-sql';
import { ArtistArtworkNotificationData } from './user-notification.types';

const PUBLIC_ARTWORK_ENTRY_SQL = `${competitionEntryVisibleSql('e')}
  and c.lifecycle in ('PUBLISHED', 'ENDED')
  and coalesce(json_unquote(json_extract(c.participation_config, '$.anonymous_submissions')), 'false') = 'false'`;

/** Artist-targeted notices must disappear entirely if attribution is hidden. */
export function artistArtworkNotificationVisibleSql(alias: string): string {
  return `(${alias}.cause <> '${IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED}' or exists (
    select 1 from ${COMPETITION_ENTRIES_TABLE} e
    join ${COMPETITIONS_TABLE} c on c.id = e.competition_id
    where e.drop_id = ${alias}.related_drop_id
      and e.submitter_id = ${alias}.additional_identity_id and ${PUBLIC_ARTWORK_ENTRY_SQL}
  ))`;
}

export type ArtistArtworkSubmission = ArtistArtworkNotificationData & {
  readonly visibility_group_id: string | null;
};

export class ArtistArtworkSubmissionDb extends LazyDbAccessCompatibleService {
  async find(
    event: Pick<
      NativeCompetitionEvent,
      'competition_id' | 'competition_entry_id' | 'drop_id' | 'wave_id'
    >,
    ctx: RequestContext
  ): Promise<ArtistArtworkSubmission | null> {
    const row = await this.db.oneOrNull<ArtistArtworkSubmission>(
      `select e.submitter_id as artist_id, e.drop_id, e.wave_id,
        e.competition_id, e.id as entry_id, e.submitted_at,
        d.title as artwork_title, c.title as competition_title, w.visibility_group_id
       from ${COMPETITION_ENTRIES_TABLE} e
       join ${COMPETITIONS_TABLE} c on c.id = e.competition_id and c.wave_id = e.wave_id
       join ${DROPS_TABLE} d on d.id = e.drop_id and d.author_id = e.submitter_id
       join ${WAVES_TABLE} w on w.id = e.wave_id
       where e.id = :entryId and e.competition_id = :competitionId
         and e.drop_id = :dropId and e.wave_id = :waveId and ${PUBLIC_ARTWORK_ENTRY_SQL}`,
      {
        entryId: event.competition_entry_id ?? null,
        competitionId: event.competition_id,
        dropId: event.drop_id ?? null,
        waveId: event.wave_id
      },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    return row ? { ...row, submitted_at: Number(row.submitted_at) } : null;
  }

  async canReceive(
    submission: ArtistArtworkSubmission,
    recipientId: string,
    eligibleGroupIds: string[],
    ctx: RequestContext
  ): Promise<boolean> {
    const row = await this.db.oneOrNull<{ id: string }>(
      `select w.id from ${WAVES_TABLE} w where w.id = :waveId
        and ${waveReadAccessSql('w', eligibleGroupIds.length > 0)}
        and not exists (select 1 from ${IDENTITY_MUTES_TABLE} m
          where m.muter_id = :recipientId and m.muted_identity_id = :artistId)
        and not exists (select 1 from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} b
          where b.blocker_profile_id = :recipientId and b.blocked_profile_id = :artistId)
        and not exists (select 1 from ${WAVE_READER_METRICS_TABLE} r
          where r.wave_id = w.id and r.reader_id = :recipientId and r.muted = true)`,
      {
        waveId: submission.wave_id,
        artistId: submission.artist_id,
        recipientId,
        eligibleGroupIds
      },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    return row !== null;
  }
}

export const artistArtworkSubmissionDb = new ArtistArtworkSubmissionDb(
  dbSupplier
);
