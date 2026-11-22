import { compareCodePoints } from './waves-export.json';

/**
 * The waves snapshot tooling's compact drop row (tools/legacy-snapshot,
 * waves_fetch.py `compact_drop`): an API drop without profile objects, the
 * reaction tally as counts. Written here from the same API drop objects the
 * public `/waves/{id}/drops` feed returns, so the two exports write the same
 * rows. A field the API leaves out is null here, as Python's `dict.get` gives.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function get(value: unknown, key: string): unknown {
  const object = asObject(value);
  return object[key] ?? null;
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** `value or default` in Python. */
function or<T>(value: unknown, fallback: T): unknown {
  return truthy(value) ? value : fallback;
}

function profileId(profile: unknown): unknown {
  return get(profile, 'id');
}

const NFT_LINK_DATA_KEYS = [
  'canonical_id',
  'chain',
  'contract',
  'token',
  'platform'
] as const;

const ATTACHMENT_KEYS = new Set([
  'attachment_id',
  'file_name',
  'mime_type',
  'url',
  'kind',
  'status'
]);

function compactPart(part: unknown): Json {
  const quoted = get(part, 'quoted_drop');
  return {
    part_id: get(part, 'part_id'),
    content: get(part, 'content'),
    media: asArray(get(part, 'media')).map((media) => ({
      url: get(media, 'url'),
      mime_type: get(media, 'mime_type')
    })),
    attachments: asArray(get(part, 'attachments')).map((attachment) => {
      const object = asObject(attachment);
      const out: Json = {};
      for (const key of Object.keys(object).sort(compareCodePoints)) {
        if (ATTACHMENT_KEYS.has(key)) {
          out[key] = object[key] ?? null;
        }
      }
      return out;
    }),
    quoted_drop: truthy(quoted)
      ? {
          drop_id: get(quoted, 'drop_id'),
          part_id: get(quoted, 'drop_part_id')
        }
      : null
  };
}

export function compactDrop(drop: unknown): Json {
  const d = asObject(drop);
  const replyTo = get(d, 'reply_to');
  const collaborators = asArray(get(d, 'collaborators'))
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => or(get(c, 'id'), null) ?? profileId(get(c, 'profile')))
    .filter((id): id is string => truthy(id) && typeof id === 'string')
    .sort(compareCodePoints);
  const reactions = asArray(get(d, 'reactions'))
    .map((reaction) => ({
      reaction: get(reaction, 'reaction'),
      count: asArray(get(reaction, 'profiles')).length
    }))
    .sort((a, b) =>
      compareCodePoints(String(a.reaction ?? ''), String(b.reaction ?? ''))
    );
  return {
    id: d.id,
    serial_no: d.serial_no,
    wave_id: get(get(d, 'wave'), 'id'),
    author: profileId(get(d, 'author')),
    created_at: get(d, 'created_at'),
    updated_at: get(d, 'updated_at'),
    drop_type: get(d, 'drop_type'),
    title: get(d, 'title'),
    parts: asArray(get(d, 'parts')).map(compactPart),
    metadata: or(get(d, 'metadata'), []),
    reply_to: truthy(replyTo)
      ? {
          drop_id:
            or(get(replyTo, 'drop_id'), null) ??
            get(get(replyTo, 'drop'), 'id'),
          part_id: get(replyTo, 'drop_part_id')
        }
      : null,
    mentioned_users: asArray(get(d, 'mentioned_users')).map((mention) => ({
      profile_id: get(mention, 'mentioned_profile_id'),
      handle_in_content: get(mention, 'handle_in_content')
    })),
    mentioned_groups: or(get(d, 'mentioned_groups'), []),
    mentioned_waves: asArray(get(d, 'mentioned_waves')).map((mention) => ({
      wave_id: or(get(mention, 'wave_id'), null) ?? get(mention, 'id'),
      name_in_content: get(mention, 'wave_name_in_content')
    })),
    referenced_nfts: or(get(d, 'referenced_nfts'), []),
    // A link's preview (price, refresh times, description) moves with the
    // market: only the link and what it names are drop content.
    nft_links: asArray(get(d, 'nft_links')).map((link) => {
      const out: Json = { url_in_text: get(link, 'url_in_text') };
      const data = get(link, 'data');
      for (const key of NFT_LINK_DATA_KEYS) {
        out[key] = get(data, key);
      }
      return out;
    }),
    reactions,
    is_author_signed: truthy(get(d, 'is_author_signed')),
    is_signed: truthy(get(d, 'is_signed')),
    moderation: get(d, 'moderation'),
    collaborators
  };
}

/**
 * A grant proof without its use counter: last_used_at moves with every drop
 * the device signs, so it is no part of the archive.
 */
export function stableGrant(grant: unknown): Json {
  const { last_used_at: _lastUsedAt, ...rest } = asObject(grant);
  return rest;
}
