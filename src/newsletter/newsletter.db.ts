import {
  CONTENT_MODERATION_DROP_STATES_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  TRANSACTIONS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  NEWSLETTER_EDITION_SOURCES_TABLE,
  NEWSLETTER_EDITIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { waveReadAccessSql } from '@/waves/wave-read-access-sql';
import { MAIN_STAGE_WAVE_ID, NewsletterWindow } from './newsletter.config';
import { nativeMainStageEntriesSource } from '@/competitions/competition-main-stage.repository';
import { publicCompetitionDropSql } from '@/competitions/competition-anonymity';
import {
  NewsletterEditionEntity,
  NewsletterEditionSourceEntity,
  NewsletterEditionStatus
} from '@/entities/INewsletterEdition';
import { SourceRecord } from './newsletter-sources';

export interface NewsletterDrop {
  id: string;
  serial_no: number;
  wave_id: string;
  wave_name: string;
  author_id: string;
  author_handle: string | null;
  created_at: number;
  title: string | null;
  reply_to_drop_id: string | null;
}

export type NewsletterWinner = NewsletterDrop & {
  decision_time: number;
  ranking: number;
  competition_id?: string | null;
  entry_id?: string | null;
};

// TypeORM's Lambda connection returns BIGINT strings; the API/test pool casts them.
type NewsletterDropRow = Omit<NewsletterDrop, 'created_at' | 'serial_no'> & {
  created_at: number | string;
  serial_no: number | string;
};

function normalizeDrop(row: NewsletterDropRow): NewsletterDrop {
  return {
    ...row,
    created_at: Number(row.created_at),
    serial_no: Number(row.serial_no)
  };
}

export interface NewsletterPart {
  drop_id: string;
  content: string | null;
  quoted_drop_id: string | null;
}

export interface NewsletterMedia {
  drop_id: string;
  url: string;
  mime_type: string;
}

export interface NewsletterMint {
  collection: 'The Memes' | 'Meme Lab';
  id: number;
  name: string | null;
  artist_seize_handle: string;
  mint_date: string | null;
  first_mint_in_window: string;
  minted_count: number;
}

// Anonymous access, including a child's parent. DMs are excluded independently
// of group configuration. No publisher memberships enter any source query.
const PUBLIC_WAVE = `${waveReadAccessSql('w', false)}
  and coalesce(w.is_direct_message, 0) = 0
  and not exists (select 1 from ${WAVES_TABLE} dm_parent
    where dm_parent.id = w.parent_wave_id and dm_parent.is_direct_message = 1)`;
/**
 * The one public filter for newsletter drops (aliases `d` for drops, `w` for
 * waves). The public history endpoint re-applies it at read time.
 */
export const PUBLIC_DROP = `${PUBLIC_WAVE}
  and ${publicCompetitionDropSql('d')}
  and not exists (select 1 from ${CONTENT_MODERATION_DROP_STATES_TABLE} moderation
    where moderation.drop_id = d.id and moderation.status <> 'VISIBLE')`;

export interface NewsletterEditionRecord {
  readonly edition_id: string;
  readonly status: NewsletterEditionStatus;
  readonly window_start: number;
  readonly window_end: number;
  readonly mode: 'scheduled' | 'manual';
  readonly drop_id: string | null;
  readonly raw_output: string;
  readonly rejection_reasons: readonly string[] | null;
  readonly sources: readonly SourceRecord[];
}

type NewsletterEditionRow = Omit<
  NewsletterEditionEntity,
  'window_start' | 'window_end' | 'created_at' | 'updated_at'
> & {
  window_start: number | string;
  window_end: number | string;
  created_at: number | string;
  updated_at: number | string;
};

export function editionSourceRows(
  editionId: string,
  sources: readonly SourceRecord[]
): NewsletterEditionSourceEntity[] {
  return sources.map((source) => ({
    edition_id: editionId,
    source_id: source.source_id,
    kind: source.kind,
    drop_id: source.drop_id,
    wave_id: source.wave_id,
    wave_name: source.wave_name,
    time: Date.parse(source.time),
    collected_at: Date.parse(source.observed_at),
    canonical_url: source.canonical_url,
    title: source.title,
    author_handle: source.author_handle,
    content_fingerprint: source.content_fingerprint,
    context_only: source.context_only
  }));
}
const DROP_SELECT = `select d.id, d.serial_no, d.wave_id, w.name as wave_name,
  d.author_id, i.handle as author_handle, d.created_at, d.title, d.reply_to_drop_id
  from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id = d.wave_id
  left join ${IDENTITIES_TABLE} i on i.profile_id = d.author_id`;

export class NewsletterDb extends LazyDbAccessCompatibleService {
  private async query<T>(
    name: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext,
    forcePool?: DbPoolName
  ): Promise<T[]> {
    const timerName = `NewsletterDb->${name}`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.execute<T>(sql, params, {
        wrappedConnection: ctx.connection,
        forcePool
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async activeWaves(
    window: NewsletterWindow,
    excludedWaveId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    return (
      await this.query<{ id: string }>(
        'activeWaves',
        `select w.id from ${WAVES_TABLE} w where ${PUBLIC_WAVE}
          and w.id <> :excludedWaveId
          and exists (select 1 from ${DROPS_TABLE} d where d.wave_id = w.id
            and d.created_at >= :start and d.created_at < :end)
          order by w.id`,
        { ...window, excludedWaveId },
        ctx
      )
    ).map((wave) => wave.id);
  }

  async recentDrops(
    waveId: string,
    window: NewsletterWindow,
    after: { createdAt: number; serialNo: number },
    excludedAuthorId: string,
    ctx: RequestContext
  ): Promise<NewsletterDrop[]> {
    const rows = await this.query<NewsletterDropRow>(
      'recentDrops',
      `${DROP_SELECT} where ${PUBLIC_DROP} and d.wave_id = :waveId
        and d.author_id <> :excludedAuthorId
        and d.created_at >= :start and d.created_at < :end
        and (d.created_at > :createdAt or
          (d.created_at = :createdAt and d.serial_no > :serialNo))
        order by d.created_at, d.serial_no limit 500`,
      { waveId, ...window, ...after, excludedAuthorId },
      ctx
    );
    return rows.map(normalizeDrop);
  }

  async contextDrops(
    ids: string[],
    end: number,
    excludedWaveId: string,
    excludedAuthorId: string,
    ctx: RequestContext
  ): Promise<NewsletterDrop[]> {
    if (!ids.length) return [];
    const rows = await this.query<NewsletterDropRow>(
      'contextDrops',
      `${DROP_SELECT} where ${PUBLIC_DROP} and d.id in (:ids)
        and d.created_at < :end and d.wave_id <> :excludedWaveId
        and d.author_id <> :excludedAuthorId`,
      { ids, end, excludedWaveId, excludedAuthorId },
      ctx
    );
    return rows.map(normalizeDrop);
  }

  async parts(ids: string[], ctx: RequestContext): Promise<NewsletterPart[]> {
    if (!ids.length) return [];
    return this.query(
      'parts',
      `select p.drop_id, p.content, p.quoted_drop_id
        from ${DROPS_PARTS_TABLE} p join ${DROPS_TABLE} d on d.id = p.drop_id
        join ${WAVES_TABLE} w on w.id = d.wave_id
        where d.id in (:ids) and ${PUBLIC_DROP}
        order by p.drop_id, p.drop_part_id`,
      { ids },
      ctx
    );
  }

  async media(ids: string[], ctx: RequestContext): Promise<NewsletterMedia[]> {
    if (!ids.length) return [];
    return this.query(
      'media',
      `select m.drop_id, m.url, m.mime_type from ${DROP_MEDIA_TABLE} m
        join ${DROPS_TABLE} d on d.id = m.drop_id
        join ${WAVES_TABLE} w on w.id = d.wave_id
        where d.id in (:ids) and ${PUBLIC_DROP} order by m.drop_id, m.id`,
      { ids },
      ctx
    );
  }

  async winners(
    window: NewsletterWindow,
    ctx: RequestContext
  ): Promise<NewsletterWinner[]> {
    const rows = await this.query<
      NewsletterDropRow & {
        decision_time: number | string;
        ranking: number;
        competition_id: string | null;
        entry_id: string | null;
      }
    >(
      'winners',
      `${DROP_SELECT.replace('select d.id', 'select winner.decision_time, winner.ranking, winner.competition_id, winner.entry_id, d.id')}
        join (
          select entry.drop_id, entry.wave_id, decision.scheduled_at as decision_time, native_winner.\`rank\` as ranking,
            case when competition.legacy_wave_id is null then entry.competition_id else null end as competition_id,
            case when competition.legacy_wave_id is null then entry.id else null end as entry_id
            from (${nativeMainStageEntriesSource('WINNER')}) entry
            join ${COMPETITIONS_TABLE} competition on competition.id=entry.competition_id
            join ${COMPETITION_DECISION_WINNERS_TABLE} native_winner on native_winner.entry_id = entry.id
              and native_winner.competition_id = entry.competition_id and native_winner.decision_id = entry.decision_id
            join ${COMPETITION_DECISIONS_TABLE} decision on decision.id = native_winner.decision_id
              and decision.competition_id = entry.competition_id
        ) winner on winner.drop_id = d.id
          and winner.wave_id = d.wave_id
        where ${PUBLIC_DROP}
          and winner.decision_time >= :start and winner.decision_time < :end
        order by winner.decision_time, winner.ranking`,
      { ...window, mainStage: MAIN_STAGE_WAVE_ID },
      ctx
    );
    return rows.map((row) => ({
      ...normalizeDrop(row),
      decision_time: Number(row.decision_time),
      ranking: row.ranking
    }));
  }

  async mints(
    window: NewsletterWindow,
    ctx: RequestContext
  ): Promise<NewsletterMint[]> {
    const batches = await Promise.all([
      this.collectionMints(
        NFTS_TABLE,
        MEMES_CONTRACT,
        'The Memes',
        window,
        ctx
      ),
      this.collectionMints(
        NFTS_MEME_LAB_TABLE,
        MEMELAB_CONTRACT,
        'Meme Lab',
        window,
        ctx
      )
    ]);
    return batches.flat();
  }

  private async collectionMints(
    table: typeof NFTS_TABLE | typeof NFTS_MEME_LAB_TABLE,
    contract: string,
    collection: NewsletterMint['collection'],
    window: NewsletterWindow,
    ctx: RequestContext
  ): Promise<NewsletterMint[]> {
    return this.query(
      `mints:${collection}`,
      `select :collection as collection, n.id, n.name, n.artist_seize_handle, n.mint_date,
        min(t.transaction_date) as first_mint_in_window, sum(t.token_count) as minted_count
        from ${TRANSACTIONS_TABLE} t join ${table} n
          on n.id = t.token_id and n.contract = t.contract
        where t.contract = :contract and t.from_address = :zero
          and t.transaction_date >= :startDate and t.transaction_date < :endDate
        group by n.id, n.name, n.artist_seize_handle, n.mint_date order by n.id`,
      {
        contract,
        collection,
        zero: '0x0000000000000000000000000000000000000000',
        startDate: new Date(window.start),
        endDate: new Date(window.end)
      },
      ctx
    );
  }

  async publishedEdition(
    editionId: string,
    waveId: string,
    authorId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const rows = await this.query<{ id: string }>(
      'publishedEdition',
      `select d.id from ${DROPS_TABLE} d
        join ${DROP_METADATA_TABLE} m on m.drop_id = d.id
        where d.wave_id = :waveId and d.author_id = :authorId
          and m.data_key = 'newsletter_edition_id' and m.data_value = :editionId limit 1`,
      { editionId, waveId, authorId },
      ctx,
      DbPoolName.WRITE
    );
    return rows[0]?.id ?? null;
  }

  /** Reads the edition row on the primary so a retry sees the latest outcome. */
  async findEdition(
    editionId: string,
    ctx: RequestContext
  ): Promise<NewsletterEditionRecord | null> {
    const rows = await this.query<NewsletterEditionRow>(
      'findEdition',
      `select * from ${NEWSLETTER_EDITIONS_TABLE} where edition_id = :editionId`,
      { editionId },
      ctx,
      DbPoolName.WRITE
    );
    const row = rows[0];
    if (!row) return null;
    return {
      edition_id: row.edition_id,
      status: row.status,
      window_start: Number(row.window_start),
      window_end: Number(row.window_end),
      mode: row.mode,
      drop_id: row.drop_id,
      raw_output: row.raw_output,
      rejection_reasons: row.rejection_reasons
        ? (JSON.parse(row.rejection_reasons) as string[])
        : null,
      sources: JSON.parse(row.sources) as SourceRecord[]
    };
  }

  /**
   * Upserts the edition outcome. Source rows exist only for published
   * editions: a later retry of a rejected edition replaces the whole row set.
   */
  async saveEdition(
    edition: NewsletterEditionRecord,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.query(
      'saveEdition',
      `insert into ${NEWSLETTER_EDITIONS_TABLE}
        (edition_id, status, window_start, window_end, mode, drop_id, raw_output,
         rejection_reasons, sources, created_at, updated_at)
        values (:editionId, :status, :windowStart, :windowEnd, :mode, :dropId, :rawOutput,
         :rejectionReasons, :sources, :now, :now)
        on duplicate key update status = values(status), drop_id = values(drop_id),
          raw_output = values(raw_output), rejection_reasons = values(rejection_reasons),
          sources = values(sources), updated_at = values(updated_at)`,
      {
        editionId: edition.edition_id,
        status: edition.status,
        windowStart: edition.window_start,
        windowEnd: edition.window_end,
        mode: edition.mode,
        dropId: edition.drop_id,
        rawOutput: edition.raw_output,
        rejectionReasons: edition.rejection_reasons
          ? JSON.stringify(edition.rejection_reasons)
          : null,
        sources: JSON.stringify(edition.sources),
        now
      },
      ctx,
      DbPoolName.WRITE
    );
    await this.query(
      'deleteEditionSources',
      `delete from ${NEWSLETTER_EDITION_SOURCES_TABLE} where edition_id = :editionId`,
      { editionId: edition.edition_id },
      ctx,
      DbPoolName.WRITE
    );
    if (edition.status !== NewsletterEditionStatus.Published) return;
    const rows = editionSourceRows(edition.edition_id, edition.sources);
    for (let i = 0; i < rows.length; i += 500) {
      await this.db.bulkInsert(
        NEWSLETTER_EDITION_SOURCES_TABLE,
        rows.slice(i, i + 500),
        [
          'edition_id',
          'source_id',
          'kind',
          'drop_id',
          'wave_id',
          'wave_name',
          'time',
          'collected_at',
          'canonical_url',
          'title',
          'author_handle',
          'content_fingerprint',
          'context_only'
        ],
        ctx
      );
    }
  }
}

export const newsletterDb = new NewsletterDb(dbSupplier);
