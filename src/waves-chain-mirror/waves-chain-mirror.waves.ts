import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiUpdateWaveHubRequest } from '@/api/generated/models/ApiUpdateWaveHubRequest';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { NewWaveDropSchema } from '@/api/drops/drop.validator';
import { WaveSchema } from '@/api/waves/wave-write.schemas';
import { WaveEntity } from '@/entities/IWave';
import { jsonObjectOf } from './waves-chain-mirror.groups';
import { chainIdOf, legacyIdOf } from './waves-chain-mirror.ids';

/**
 * The chain's waves in 6529.io's `waves`. A wave made on the
 * chain is created under its chain id, as 6529.io's own wave create writes
 * a chat wave; an imported wave keeps 6529.io's row until the chain
 * replaces its policy (policy version above 1), and then takes what the
 * chain says of it:
 *
 *   readGroup       visibility_group_id
 *   postGroup       chat_group_id, while chat is on (with chat off the
 *                   import made the post group the admin group or a group
 *                   of the controller alone, and 6529.io keeps its own)
 *   adminGroup      admin_group_id
 *   controller      created_by (6529.io's admin rights come from it)
 *   status closed   chat off (6529.io has no closed wave)
 *   the document    name, picture, chat settings, the admin's drop
 *   (docClass 3)    deletion, the description drop and waves_metadatas;
 *                   the parent wave only when the wave is created
 *
 * The document is untrusted input: it passes 6529.io's create-wave schema
 * before anything of it is written.
 */

/** A row of chain_waves, as the mirror reads it. */
export interface ChainWaveRow {
  readonly wave_id: string;
  readonly legacy_id: string | null;
  readonly status: string;
  readonly read_group_id: string | null;
  readonly post_group_id: string | null;
  readonly admin_group_id: string | null;
  readonly origin: string;
  readonly data: unknown;
}

export interface ChainWave {
  readonly waveId: string;
  readonly legacyId: string | null;
  readonly origin: string;
  readonly status: string;
  readonly controller: string | null;
  readonly policyVersion: number;
  readonly metadataCid: string | null;
  readonly readGroupId: string | null;
  readonly postGroupId: string | null;
  readonly adminGroupId: string | null;
}

export function chainWaveOf(row: ChainWaveRow): ChainWave {
  const data = jsonObjectOf(row.data);
  const cid =
    typeof data.metadataCid === 'string' &&
    /^0x[0-9a-fA-F]{2,}$/.test(data.metadataCid)
      ? data.metadataCid.toLowerCase()
      : null;
  return {
    waveId: row.wave_id.toLowerCase(),
    legacyId: legacyIdOf(row.legacy_id),
    origin: row.origin,
    status: row.status,
    controller: chainIdOf(data.controller),
    policyVersion: Number(data.policyVersion ?? 1) || 1,
    metadataCid: cid,
    readGroupId: chainIdOf(row.read_group_id),
    postGroupId: chainIdOf(row.post_group_id),
    adminGroupId: chainIdOf(row.admin_group_id)
  };
}

/** A wave's 6529.io id: an imported wave's own, else its chain id. */
export function waveIdOf(wave: Pick<ChainWave, 'waveId' | 'legacyId'>): string {
  return wave.legacyId ?? wave.waveId;
}

/**
 * Whether the mirror writes this wave: one made on the chain, or an
 * imported one whose policy the chain replaced or that it closed.
 */
export function isChainOwnedWave(wave: ChainWave): boolean {
  return (
    wave.origin === 'native' ||
    wave.policyVersion > 1 ||
    wave.status === 'closed'
  );
}

/**
 * What of the chain a wave's rows were written from. A wave whose key is
 * the one the mirror last wrote is passed over.
 */
export function waveWrittenKey(wave: ChainWave): string {
  return JSON.stringify([
    wave.policyVersion,
    wave.metadataCid,
    wave.controller,
    wave.status,
    wave.readGroupId,
    wave.postGroupId,
    wave.adminGroupId
  ]);
}

export interface WaveDocumentMedia {
  readonly url: string;
  readonly mime_type: string;
}

export interface WaveDocumentPart {
  readonly content: string | null;
  readonly media: readonly WaveDocumentMedia[];
}

/** A wave's document (docClass 3), as the frontend and the import write it. */
export interface WaveDocument {
  readonly name: string;
  readonly picture: string | null;
  readonly description: readonly WaveDocumentPart[];
  readonly parentWave: string | null;
  readonly chat: {
    readonly enabled: boolean;
    readonly linksDisabled: boolean;
    readonly repliesOpen: boolean | null;
    readonly repliesCollapsed: boolean | null;
    readonly slowModeCooldownMs: number | null;
  };
  readonly adminDropDeletionEnabled: boolean;
  readonly createdAt: number | null;
  /** waves_metadatas by data key; null when the document has none. */
  readonly metadata: Readonly<Record<string, string>> | null;
}

export type WaveDocumentRead =
  | { readonly ok: true; readonly doc: WaveDocument }
  | { readonly ok: false; readonly reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;
const boolOrNull = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null;
const stringOrNull = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;

/** A wave document's fields; the reason when its shape is not a wave's. */
export function parseWaveDocument(bytes: Uint8Array): WaveDocumentRead {
  const invalid = (reason: string): WaveDocumentRead => ({
    ok: false,
    reason
  });
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return invalid('wave_document_not_json');
  }
  if (!isObject(doc) || doc.kind !== 'wave' || doc.v !== 1) {
    return invalid('wave_document_not_a_wave');
  }
  if (typeof doc.name !== 'string') return invalid('wave_document_invalid');
  if (doc.picture !== null && doc.picture !== undefined) {
    if (typeof doc.picture !== 'string') {
      return invalid('wave_document_invalid');
    }
  }
  const parts = Array.isArray(doc.description) ? doc.description : null;
  if (!parts) return invalid('wave_document_invalid');
  const description: WaveDocumentPart[] = [];
  for (const part of parts) {
    if (!isObject(part)) return invalid('wave_document_invalid');
    const media = Array.isArray(part.media) ? part.media : [];
    if (
      !media.every(
        (m) =>
          isObject(m) &&
          typeof m.url === 'string' &&
          typeof m.mime_type === 'string'
      )
    ) {
      return invalid('wave_document_invalid');
    }
    description.push({
      content: stringOrNull(part.content),
      media: media.map((m) => ({
        url: String((m as Record<string, unknown>).url),
        mime_type: String((m as Record<string, unknown>).mime_type)
      }))
    });
  }
  const chat = isObject(doc.chat) ? doc.chat : {};
  const replies = isObject(chat.replies) ? chat.replies : {};
  const slowMode = Number(chat.slow_mode_cooldown_ms);
  let metadata: Record<string, string> | null = null;
  if (doc.metadata !== undefined && doc.metadata !== null) {
    if (!isObject(doc.metadata)) return invalid('wave_document_invalid');
    metadata = {};
    for (const [key, value] of Object.entries(doc.metadata)) {
      if (typeof value !== 'string') return invalid('wave_document_invalid');
      metadata[key] = value;
    }
  }
  const createdAt = Number(doc.created_at);
  return {
    ok: true,
    doc: {
      name: doc.name,
      picture: stringOrNull(doc.picture),
      description,
      parentWave: stringOrNull(doc.parent_wave),
      chat: {
        enabled: boolOr(chat.enabled, true),
        linksDisabled: boolOr(chat.links_disabled, false),
        repliesOpen: boolOrNull(replies.open),
        repliesCollapsed: boolOrNull(replies.collapsed),
        slowModeCooldownMs:
          chat.slow_mode_cooldown_ms === null ||
          chat.slow_mode_cooldown_ms === undefined ||
          !Number.isSafeInteger(slowMode)
            ? null
            : slowMode
      },
      adminDropDeletionEnabled: boolOr(doc.admin_drop_deletion_enabled, false),
      createdAt:
        Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : null,
      metadata
    }
  };
}

/** A wave's groups as 6529.io's ids (null: none). */
export interface WaveGroups {
  readonly visibility: string | null;
  readonly chat: string | null;
  readonly admin: string | null;
}

/** An empty description part: what a held description shows. */
export const EMPTY_DESCRIPTION: readonly WaveDocumentPart[] = [
  { content: null, media: [] }
];

/**
 * The create-wave request 6529.io's own form sends for a chat wave with
 * this document and these groups (the frontend's getCreateNewWaveBody).
 */
export function newWaveRequestOf(input: {
  readonly doc: WaveDocument;
  readonly groups: WaveGroups;
  readonly chatEnabled: boolean;
  readonly picture: string | null;
  readonly description: readonly WaveDocumentPart[];
  readonly parentWaveId: string | null;
}): ApiCreateNewWave {
  const { doc, groups } = input;
  const replies =
    doc.chat.repliesOpen === null && doc.chat.repliesCollapsed === null
      ? undefined
      : {
          open: doc.chat.repliesOpen ?? false,
          collapsed: doc.chat.repliesCollapsed ?? false
        };
  return {
    name: doc.name,
    picture: input.picture,
    parent_wave_id: input.parentWaveId,
    description_drop: {
      title: null,
      parts: input.description.map((part) => ({
        content: part.content,
        quoted_drop: null,
        media: part.media.map((m) => ({ url: m.url, mime_type: m.mime_type }))
      })),
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      signature: null
    },
    voting: {
      scope: { group_id: null },
      credit_type: ApiWaveCreditType.Tdh,
      credit_scope: ApiWaveCreditScope.Wave,
      credit_category: null,
      creditor_id: null,
      signature_required: false,
      period: null,
      forbid_negative_votes: false
    } as unknown as ApiCreateNewWave['voting'],
    visibility: { scope: { group_id: groups.visibility } },
    participation: {
      scope: { group_id: null },
      no_of_applications_allowed_per_participant: null,
      required_media: [],
      required_metadata: [],
      signature_required: false,
      period: null as unknown as undefined,
      terms: null
    },
    chat: {
      scope: { group_id: groups.chat },
      enabled: input.chatEnabled,
      links_disabled: doc.chat.linksDisabled,
      ...(doc.chat.slowModeCooldownMs !== null
        ? { slow_mode_cooldown_ms: doc.chat.slowModeCooldownMs }
        : {}),
      ...(replies ? { replies } : {})
    },
    wave: {
      type: ApiWaveType.Chat,
      winning_threshold: null,
      max_winners: null,
      time_lock_ms: null,
      admin_group: { group_id: groups.admin },
      decisions_strategy: null,
      admin_drop_deletion_enabled: doc.adminDropDeletionEnabled
    },
    outcomes: []
  };
}

export type WaveRequestCheck =
  | {
      readonly ok: true;
      readonly request: ApiCreateNewWave;
      /** The document's fields left out to pass the schema. */
      readonly dropped: readonly ('picture' | 'description')[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The create-wave request for a document, checked by 6529.io's own schema
 * (WaveSchema). A picture or a description the schema refuses is left out
 * (a wave on the chain can't be refused, and a chat needs its row); a wave
 * that fails anyway (its name) is held back.
 */
export function checkedWaveRequest(
  input: Omit<Parameters<typeof newWaveRequestOf>[0], 'picture' | 'description'>
): WaveRequestCheck {
  const dropped: ('picture' | 'description')[] = [];
  const validate = (request: ApiCreateNewWave) =>
    WaveSchema.validate(request, { abortEarly: true });
  let picture = input.doc.picture;
  let description: readonly WaveDocumentPart[] = input.doc.description.length
    ? input.doc.description
    : EMPTY_DESCRIPTION;
  const descriptionCheck = NewWaveDropSchema.validate(
    newWaveRequestOf({ ...input, picture, description }).description_drop
  );
  if (descriptionCheck.error) {
    description = EMPTY_DESCRIPTION;
    dropped.push('description');
  }
  let result = validate(newWaveRequestOf({ ...input, picture, description }));
  if (result.error && picture !== null) {
    const withoutPicture = validate(
      newWaveRequestOf({ ...input, picture: null, description })
    );
    if (!withoutPicture.error) {
      picture = null;
      dropped.push('picture');
      result = withoutPicture;
    }
  }
  if (result.error) {
    return { ok: false, reason: 'wave_document_refused' };
  }
  return { ok: true, request: result.value as ApiCreateNewWave, dropped };
}

/** The `waves` fields the chain sets on a wave that exists. */
export type WaveHubFields = Pick<
  WaveEntity,
  | 'name'
  | 'picture'
  | 'visibility_group_id'
  | 'admin_group_id'
  | 'chat_group_id'
  | 'chat_enabled'
  | 'chat_links_disabled'
  | 'chat_slow_mode_cooldown_ms'
  | 'chat_replies_open'
  | 'chat_replies_collapsed'
  | 'admin_drop_deletion_enabled'
>;

/**
 * 6529.io's hub patch (ApiUpdateWaveHubRequest, as the wave edit takes it)
 * from a wave's row to the fields the chain sets; empty when they agree.
 */
export function waveHubPatchOf(
  before: WaveHubFields,
  after: Partial<WaveHubFields>
): ApiUpdateWaveHubRequest {
  const patch: ApiUpdateWaveHubRequest = {};
  const changed = <K extends keyof WaveHubFields>(key: K) =>
    after[key] !== undefined && after[key] !== before[key];
  if (changed('name')) patch.name = after.name!;
  if (changed('picture')) patch.picture = after.picture!;
  if (changed('visibility_group_id')) {
    patch.visibility = { scope: { group_id: after.visibility_group_id! } };
  }
  if (changed('admin_group_id')) {
    patch.admin_group = { group_id: after.admin_group_id! };
  }
  if (changed('admin_drop_deletion_enabled')) {
    patch.admin_drop_deletion_enabled = after.admin_drop_deletion_enabled!;
  }
  const chat: NonNullable<ApiUpdateWaveHubRequest['chat']> = {};
  if (changed('chat_group_id')) {
    chat.scope = { group_id: after.chat_group_id! };
  }
  if (changed('chat_enabled')) chat.enabled = after.chat_enabled!;
  if (changed('chat_links_disabled')) {
    chat.links_disabled = after.chat_links_disabled!;
  }
  if (changed('chat_slow_mode_cooldown_ms')) {
    chat.slow_mode_cooldown_ms = after.chat_slow_mode_cooldown_ms!;
  }
  if (changed('chat_replies_open') || changed('chat_replies_collapsed')) {
    chat.replies = {
      open: after.chat_replies_open ?? before.chat_replies_open,
      collapsed: after.chat_replies_collapsed ?? before.chat_replies_collapsed
    };
  }
  if (Object.keys(chat).length) patch.chat = chat;
  return patch;
}

/** Whether a description drop's parts are the document's. */
export function sameDescription(
  current: readonly WaveDocumentPart[],
  next: readonly WaveDocumentPart[]
): boolean {
  const norm = (parts: readonly WaveDocumentPart[]) =>
    JSON.stringify(
      parts.map((p) => [
        p.content ?? null,
        p.media.map((m) => [m.url, m.mime_type])
      ])
    );
  return norm(current) === norm(next);
}

/**
 * waves_metadatas changes for a document: its keys set to its values; a
 * key the mirror wrote before and the document no longer has deleted.
 * 6529.io's own keys the chain never named stay (an imported wave's
 * documents carry none until an edit sets one).
 */
export function metadataChangesOf(input: {
  readonly current: ReadonlyMap<string, string>;
  readonly next: Readonly<Record<string, string>> | null;
  readonly writtenBefore: readonly string[];
}): {
  readonly upsert: { key: string; value: string }[];
  readonly remove: string[];
} {
  const next = input.next ?? {};
  const upsert = Object.entries(next)
    .filter(([key, value]) => input.current.get(key) !== value)
    .map(([key, value]) => ({ key, value }));
  const remove = input.writtenBefore.filter(
    (key) => !(key in next) && input.current.has(key)
  );
  return { upsert, remove };
}

/**
 * A document's metadata as 6529.io's metadata route takes it (a key of 1
 * to 500 characters once trimmed, a value of 1 to 8,000); the entries left
 * out are counted.
 */
export function validMetadataOf(
  metadata: Readonly<Record<string, string>> | null
): { readonly valid: Record<string, string> | null; readonly dropped: number } {
  if (metadata === null) return { valid: null, dropped: 0 };
  const valid: Record<string, string> = {};
  let dropped = 0;
  for (const [rawKey, value] of Object.entries(metadata)) {
    const key = rawKey.trim();
    if (
      key.length < 1 ||
      key.length > 500 ||
      value.length < 1 ||
      value.length > 8000
    ) {
      dropped++;
      continue;
    }
    valid[key] = value;
  }
  return { valid, dropped };
}
