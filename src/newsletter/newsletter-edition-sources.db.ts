import {
  DROPS_TABLE,
  NEWSLETTER_EDITION_SOURCES_TABLE,
  NEWSLETTER_EDITIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { NewsletterEditionStatus } from '@/entities/INewsletterEdition';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { PUBLIC_DROP } from './newsletter.db';
import { SourceKind } from './newsletter-sources';

export interface CommunityMemorySourceRow {
  readonly edition_id: string;
  readonly source_id: string;
  readonly kind: SourceKind;
  readonly drop_id: string | null;
  readonly wave_id: string | null;
  readonly wave_name: string | null;
  readonly time: number;
  readonly collected_at: number;
  readonly canonical_url: string;
  readonly title: string | null;
  readonly author_handle: string | null;
  readonly content_fingerprint: string;
}

export interface CommunityMemorySourceCursor {
  readonly time: number;
  readonly sourceId: string;
}

export interface CommunityMemorySourceFilter {
  readonly waveId?: string;
  readonly editionId?: string;
  readonly from?: number;
  readonly to?: number;
  readonly after?: CommunityMemorySourceCursor;
  /** Rows to read; callers ask for one more than the page to detect has_more. */
  readonly limit: number;
}

type RawRow = Omit<CommunityMemorySourceRow, 'time' | 'collected_at'> & {
  time: number | string;
  collected_at: number | string;
};

/**
 * Public history reads over validated edition sources. Every drop-backed row
 * is re-joined to the live drop through the collector's public filter, so a
 * drop that was deleted, hidden, moderated or moved behind wave restrictions
 * after publication is no longer returned.
 */
export class NewsletterEditionSourcesDb extends LazyDbAccessCompatibleService {
  async listPublicSources(
    filter: CommunityMemorySourceFilter,
    ctx: RequestContext
  ): Promise<CommunityMemorySourceRow[]> {
    const conditions: string[] = [
      `e.status = :published`,
      `(s.drop_id is null or exists (select 1 from ${DROPS_TABLE} d
          join ${WAVES_TABLE} w on w.id = d.wave_id
          where d.id = s.drop_id and ${PUBLIC_DROP}))`
    ];
    const params: Record<string, unknown> = {
      published: NewsletterEditionStatus.Published,
      limit: filter.limit
    };
    if (filter.waveId !== undefined) {
      conditions.push('s.wave_id = :waveId');
      params.waveId = filter.waveId;
    }
    if (filter.editionId !== undefined) {
      conditions.push('s.edition_id = :editionId');
      params.editionId = filter.editionId;
    }
    if (filter.from !== undefined) {
      conditions.push('s.time >= :from');
      params.from = filter.from;
    }
    if (filter.to !== undefined) {
      conditions.push('s.time < :to');
      params.to = filter.to;
    }
    if (filter.after) {
      conditions.push(
        '(s.time > :afterTime or (s.time = :afterTime and s.source_id > :afterSourceId))'
      );
      params.afterTime = filter.after.time;
      params.afterSourceId = filter.after.sourceId;
    }
    const timerName = 'NewsletterEditionSourcesDb->listPublicSources';
    ctx.timer?.start(timerName);
    try {
      const rows = await this.db.execute<RawRow>(
        `select s.edition_id, s.source_id, s.kind, s.drop_id, s.wave_id, s.wave_name,
            s.time, s.collected_at, s.canonical_url, s.title, s.author_handle,
            s.content_fingerprint
          from ${NEWSLETTER_EDITION_SOURCES_TABLE} s
          join ${NEWSLETTER_EDITIONS_TABLE} e on e.edition_id = s.edition_id
          where ${conditions.join('\n            and ')}
          order by s.time, s.source_id
          limit :limit`,
        params,
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.READ }
      );
      return rows.map((row) => ({
        ...row,
        time: Number(row.time),
        collected_at: Number(row.collected_at)
      }));
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const newsletterEditionSourcesDb = new NewsletterEditionSourcesDb(
  dbSupplier
);
