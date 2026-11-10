import { createHash } from 'node:crypto';
import { TEAM_WAVE_IDS } from './newsletter.config';
import {
  NewsletterDrop,
  NewsletterMedia,
  NewsletterMint,
  NewsletterPart,
  NewsletterWinner
} from './newsletter.db';

export type SourceKind = 'DROP' | 'WINNER' | 'MINT' | 'IDENTITY';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'DROP',
  'WINNER',
  'MINT',
  'IDENTITY'
];

/** Source ids are deterministic and derived only from database identifiers. */
export const SOURCE_ID_PATTERN =
  /^(drop|winner|mint|identity):[^\s[\]()<>]{1,180}$/;

/**
 * One validated source record. Every field is populated from database rows
 * at collection time; nothing here is derived from model output.
 */
export interface SourceRecord {
  readonly source_id: string;
  readonly kind: SourceKind;
  readonly canonical_url: string;
  readonly title: string | null;
  readonly author_handle: string | null;
  readonly wave_id: string | null;
  readonly wave_name: string | null;
  /** ISO time the collector read the record from the database. */
  readonly observed_at: string;
  /** sha256 (hex) of the collected text parts / identifying fields. */
  readonly content_fingerprint: string;
  /** ISO event time: drop creation, winning decision, first mint in window. */
  readonly time: string;
  /** Older context (reply/quote roots) or reference entries exempt from the window rule. */
  readonly context_only: boolean;
  readonly drop_id: string | null;
  readonly team_wave: boolean;
}

export type SourceRegistry = ReadonlyMap<string, SourceRecord>;

export const SITE = 'https://6529.io';

export const dropSourceId = (dropId: string): string => `drop:${dropId}`;

export const winnerSourceId = (
  winner: Pick<NewsletterWinner, 'id' | 'competition_id' | 'entry_id'>
): string =>
  winner.competition_id && winner.entry_id
    ? `winner:${winner.competition_id}:${winner.entry_id}`
    : dropSourceId(winner.id);

export const mintCollectionSlug = (
  collection: NewsletterMint['collection']
): 'the-memes' | 'meme-lab' =>
  collection === 'Meme Lab' ? 'meme-lab' : 'the-memes';

export const mintSourceId = (
  collection: NewsletterMint['collection'],
  cardId: number
): string => `mint:${mintCollectionSlug(collection)}:${cardId}`;

export const identitySourceId = (profileId: string): string =>
  `identity:${profileId}`;

export const discussionUrl = (
  drop: Pick<NewsletterDrop, 'wave_id' | 'serial_no'>
): string =>
  `${SITE}/waves/${encodeURIComponent(drop.wave_id)}?serialNo=${drop.serial_no}`;

export const profileUrl = (handle: string): string =>
  `${SITE}/${encodeURIComponent(handle)}`;

export const winnerUrl = (winner: NewsletterWinner): string =>
  winner.competition_id && winner.entry_id
    ? `${SITE}/waves/${encodeURIComponent(winner.wave_id)}/competitions/${encodeURIComponent(winner.competition_id)}?entry=${encodeURIComponent(winner.entry_id)}`
    : discussionUrl(winner);

export const mintUrl = (mint: Pick<NewsletterMint, 'collection' | 'id'>) =>
  `${SITE}/${mintCollectionSlug(mint.collection)}/${mint.id}`;

export function contentFingerprint(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export interface SourceRegistryInput {
  readonly drops: ReadonlyMap<string, NewsletterDrop>;
  readonly parts: ReadonlyMap<string, NewsletterPart[]>;
  readonly media: ReadonlyMap<string, NewsletterMedia[]>;
  readonly winners: readonly NewsletterWinner[];
  readonly mints: readonly NewsletterMint[];
  readonly windowStart: number;
  readonly observedAt: number;
}

function dropRecord(
  drop: NewsletterDrop,
  input: SourceRegistryInput,
  observedAt: string
): SourceRecord {
  const parts = input.parts.get(drop.id) ?? [];
  const media = input.media.get(drop.id) ?? [];
  return {
    source_id: dropSourceId(drop.id),
    kind: 'DROP',
    canonical_url: discussionUrl(drop),
    title: drop.title,
    author_handle: drop.author_handle,
    wave_id: drop.wave_id,
    wave_name: drop.wave_name,
    observed_at: observedAt,
    content_fingerprint: contentFingerprint({
      title: drop.title,
      text: parts.map((part) => part.content ?? ''),
      quoted: parts.map((part) => part.quoted_drop_id),
      media: media.map((item) => item.url)
    }),
    time: new Date(drop.created_at).toISOString(),
    context_only: drop.created_at < input.windowStart,
    drop_id: drop.id,
    team_wave: TEAM_WAVE_IDS.includes(drop.wave_id)
  };
}

function winnerRecord(
  winner: NewsletterWinner,
  observedAt: string
): SourceRecord {
  return {
    source_id: winnerSourceId(winner),
    kind: 'WINNER',
    canonical_url: winnerUrl(winner),
    title: winner.title,
    author_handle: winner.author_handle,
    wave_id: winner.wave_id,
    wave_name: winner.wave_name,
    observed_at: observedAt,
    content_fingerprint: contentFingerprint({
      drop_id: winner.id,
      title: winner.title,
      decision_time: winner.decision_time,
      ranking: winner.ranking
    }),
    time: new Date(winner.decision_time).toISOString(),
    context_only: false,
    drop_id: winner.id,
    team_wave: false
  };
}

function mintRecord(mint: NewsletterMint, observedAt: string): SourceRecord {
  return {
    source_id: mintSourceId(mint.collection, mint.id),
    kind: 'MINT',
    canonical_url: mintUrl(mint),
    title: mint.name,
    author_handle: null,
    wave_id: null,
    wave_name: null,
    observed_at: observedAt,
    content_fingerprint: contentFingerprint({
      collection: mint.collection,
      id: mint.id,
      name: mint.name,
      artist_seize_handle: mint.artist_seize_handle,
      mint_date: mint.mint_date,
      minted_count: Number(mint.minted_count)
    }),
    time: new Date(mint.first_mint_in_window).toISOString(),
    context_only: false,
    drop_id: null,
    team_wave: false
  };
}

function identityRecord(
  profileId: string,
  handle: string,
  observedAt: string
): SourceRecord {
  return {
    source_id: identitySourceId(profileId),
    kind: 'IDENTITY',
    canonical_url: profileUrl(handle),
    title: handle,
    author_handle: handle,
    wave_id: null,
    wave_name: null,
    observed_at: observedAt,
    content_fingerprint: contentFingerprint({ profile_id: profileId, handle }),
    time: observedAt,
    // A profile is a reference, not an event inside the reporting window.
    context_only: true,
    drop_id: null,
    team_wave: false
  };
}

/**
 * Builds the registry the validator and renderer trust. Only database rows
 * enter it; model output can cite these ids but never add to them.
 */
export function buildSourceRegistry(
  input: SourceRegistryInput
): Map<string, SourceRecord> {
  const observedAt = new Date(input.observedAt).toISOString();
  const registry = new Map<string, SourceRecord>();
  const add = (record: SourceRecord) => {
    if (!registry.has(record.source_id)) registry.set(record.source_id, record);
  };
  const identities = new Map<string, string>();
  const noteAuthor = (
    drop: Pick<NewsletterDrop, 'author_id' | 'author_handle'>
  ) => {
    if (drop.author_handle && !identities.has(drop.author_id)) {
      identities.set(drop.author_id, drop.author_handle);
    }
  };
  for (const drop of Array.from(input.drops.values())) {
    add(dropRecord(drop, input, observedAt));
    noteAuthor(drop);
  }
  for (const winner of input.winners) {
    add(winnerRecord(winner, observedAt));
    noteAuthor(winner);
  }
  for (const mint of input.mints) add(mintRecord(mint, observedAt));
  for (const [profileId, handle] of Array.from(identities.entries())) {
    add(identityRecord(profileId, handle, observedAt));
  }
  return registry;
}

export function registryFromRecords(
  records: readonly SourceRecord[]
): Map<string, SourceRecord> {
  return new Map(records.map((record) => [record.source_id, record]));
}
