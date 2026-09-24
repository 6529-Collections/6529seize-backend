import { RequestContext } from '@/request.context';
import { NewsletterWindow, TEAM_WAVE_IDS } from './newsletter.config';
import { NewsletterCollectionBudget } from './newsletter-collection-budget';
import {
  NewsletterDb,
  NewsletterDrop,
  NewsletterPart,
  NewsletterMedia,
  NewsletterMint
} from './newsletter.db';

export const discussionUrl = (drop: NewsletterDrop): string =>
  `https://6529.io/waves/${drop.wave_id}?serialNo=${drop.serial_no}`;

export interface NewsletterSource {
  url: string;
  discussion_start: string;
  wave: string;
  team_wave: boolean;
  author: string | null;
  author_url: string | null;
  time: string;
  context_only: boolean;
  title: string | null;
  text: string[];
  quoted_messages: string[];
  media: { url: string; mime_type: string }[];
}

export interface NewsletterMaterial {
  window: { start: string; end: string };
  sources: NewsletterSource[];
  winners: {
    author: string | null;
    author_url: string | null;
    title: string | null;
    url: string;
    decision_time: string;
    ranking: number;
  }[];
  mints: {
    collection: NewsletterMint['collection'];
    card: number;
    title: string | null;
    url: string;
    artists: { handle: string; url: string }[];
    first_mint: string | null;
    first_mint_in_window: string;
    minted_count: number;
  }[];
}

function groupByDrop<T extends { drop_id: string }>(
  rows: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.drop_id) ?? [];
    group.push(row);
    groups.set(row.drop_id, group);
  }
  return groups;
}

export function discussionStart(
  drop: NewsletterDrop,
  drops: Map<string, NewsletterDrop>
): NewsletterDrop {
  const visited = new Set<string>([drop.id]);
  let root = drop;
  while (root.reply_to_drop_id) {
    const parent = drops.get(root.reply_to_drop_id);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    root = parent;
  }
  return root;
}

function sourceForDrop(
  drop: NewsletterDrop,
  drops: Map<string, NewsletterDrop>,
  parts: Map<string, NewsletterPart[]>,
  media: Map<string, NewsletterMedia[]>,
  start: number
): NewsletterSource {
  const content = parts.get(drop.id) ?? [];
  return {
    url: discussionUrl(drop),
    discussion_start: discussionUrl(discussionStart(drop, drops)),
    wave: drop.wave_name,
    team_wave: TEAM_WAVE_IDS.includes(drop.wave_id),
    author: drop.author_handle,
    author_url: drop.author_handle
      ? `https://6529.io/${encodeURIComponent(drop.author_handle)}`
      : null,
    time: new Date(drop.created_at).toISOString(),
    context_only: drop.created_at < start,
    title: drop.title,
    text: content.flatMap((part) => (part.content ? [part.content] : [])),
    quoted_messages: content.flatMap((part) => {
      const quoted = part.quoted_drop_id
        ? drops.get(part.quoted_drop_id)
        : undefined;
      return quoted ? [discussionUrl(quoted)] : [];
    }),
    media: (media.get(drop.id) ?? []).map(({ url, mime_type }) => ({
      url,
      mime_type
    }))
  };
}

export class NewsletterCollector {
  constructor(private readonly db: NewsletterDb) {}

  async collect(
    window: NewsletterWindow,
    excludedWaveId: string,
    excludedAuthorId: string,
    ctx: RequestContext
  ): Promise<NewsletterMaterial> {
    const budget = new NewsletterCollectionBudget();
    const waves = await this.db.activeWaves(window, excludedWaveId, ctx);
    budget.checkTime();
    const drops = new Map<string, NewsletterDrop>();
    // Indexed per-wave ranges include subwaves and paginate every active wave.
    for (let i = 0; i < waves.length; i += 4) {
      const batches = await Promise.all(
        waves
          .slice(i, i + 4)
          .map((waveId) =>
            this.readWave(waveId, window, excludedAuthorId, budget, ctx)
          )
      );
      for (const drop of batches.flat()) drops.set(drop.id, drop);
    }
    const [winners, mints] = await Promise.all([
      this.db.winners(window, ctx),
      this.db.mints(window, ctx)
    ]);
    budget.checkTime();
    for (const winner of winners) {
      if (!drops.has(winner.id)) budget.addDrops(1);
      drops.set(winner.id, winner);
    }
    const parts: NewsletterPart[] = [];
    const media: NewsletterMedia[] = [];
    await this.addContext(
      drops,
      parts,
      media,
      window.end,
      excludedWaveId,
      excludedAuthorId,
      budget,
      ctx
    );
    const partsByDrop = groupByDrop(parts);
    const mediaByDrop = groupByDrop(media);
    return {
      window: {
        start: new Date(window.start).toISOString(),
        end: new Date(window.end).toISOString()
      },
      sources: Array.from(drops.values())
        .sort(
          (a, b) => a.created_at - b.created_at || a.serial_no - b.serial_no
        )
        .map((drop) =>
          sourceForDrop(drop, drops, partsByDrop, mediaByDrop, window.start)
        ),
      winners: winners.map((winner) => ({
        author: winner.author_handle,
        author_url: winner.author_handle
          ? `https://6529.io/${encodeURIComponent(winner.author_handle)}`
          : null,
        title: winner.title,
        url: discussionUrl(winner),
        decision_time: new Date(winner.decision_time).toISOString(),
        ranking: winner.ranking
      })),
      mints: mints.map((mint) => ({
        collection: mint.collection,
        card: mint.id,
        title: mint.name,
        url: `https://6529.io/${mint.collection === 'Meme Lab' ? 'meme-lab' : 'the-memes'}/${mint.id}`,
        artists: mint.artist_seize_handle
          .split(',')
          .map((handle) => handle.trim())
          .filter(Boolean)
          .map((handle) => ({
            handle,
            url: `https://6529.io/${encodeURIComponent(handle)}`
          })),
        first_mint: mint.mint_date
          ? new Date(mint.mint_date).toISOString()
          : null,
        first_mint_in_window: new Date(mint.first_mint_in_window).toISOString(),
        minted_count: Number(mint.minted_count)
      }))
    };
  }

  private async readWave(
    waveId: string,
    window: NewsletterWindow,
    authorId: string,
    budget: NewsletterCollectionBudget,
    ctx: RequestContext
  ): Promise<NewsletterDrop[]> {
    const result: NewsletterDrop[] = [];
    let cursor = { createdAt: window.start, serialNo: 0 };
    for (;;) {
      budget.checkTime();
      const page = await this.db.recentDrops(
        waveId,
        window,
        cursor,
        authorId,
        ctx
      );
      budget.addDrops(page.length);
      result.push(...page);
      if (page.length < 500) return result;
      const last = page[page.length - 1];
      cursor = { createdAt: last.created_at, serialNo: last.serial_no };
    }
  }

  private async addContext(
    drops: Map<string, NewsletterDrop>,
    parts: NewsletterPart[],
    media: NewsletterMedia[],
    end: number,
    waveId: string,
    authorId: string,
    budget: NewsletterCollectionBudget,
    ctx: RequestContext
  ): Promise<void> {
    let pending = Array.from(drops.keys());
    const attempted = new Set(pending);
    // Follow reply and quote chains to their publicly accessible beginnings.
    while (pending.length) {
      budget.nextContextRound();
      const referenced = new Set<string>();
      for (let i = 0; i < pending.length; i += 500) {
        const ids = pending.slice(i, i + 500);
        const references = await this.readContent(
          ids,
          drops,
          parts,
          media,
          budget,
          ctx
        );
        references.forEach((id) => referenced.add(id));
      }
      const unseen = Array.from(referenced).filter((id) => !attempted.has(id));
      pending = [];
      for (let i = 0; i < unseen.length; i += 500) {
        budget.checkTime();
        const ids = unseen.slice(i, i + 500);
        ids.forEach((id) => attempted.add(id));
        const context = await this.db.contextDrops(
          ids,
          end,
          waveId,
          authorId,
          ctx
        );
        budget.addDrops(context.length);
        for (const drop of context) {
          drops.set(drop.id, drop);
          pending.push(drop.id);
        }
      }
    }
  }

  private async readContent(
    ids: string[],
    drops: Map<string, NewsletterDrop>,
    parts: NewsletterPart[],
    media: NewsletterMedia[],
    budget: NewsletterCollectionBudget,
    ctx: RequestContext
  ): Promise<string[]> {
    budget.checkTime();
    const [batchParts, batchMedia] = await Promise.all([
      this.db.parts(ids, ctx),
      this.db.media(ids, ctx)
    ]);
    budget.addContent([
      ...batchParts.map((part) => part.content ?? ''),
      ...batchMedia.map((item) => item.url)
    ]);
    parts.push(...batchParts);
    media.push(...batchMedia);
    const replies = ids.map((id) => drops.get(id)?.reply_to_drop_id);
    const quotes = batchParts.map((part) => part.quoted_drop_id);
    return [...replies, ...quotes].filter((id): id is string => !!id);
  }
}
