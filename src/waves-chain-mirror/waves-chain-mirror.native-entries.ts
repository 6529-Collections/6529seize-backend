import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { NewDropSchema } from '@/api/drops/drop.validator';
import { CLOUDFRONT_LINK } from '@/constants';
import { numbers } from '@/numbers';
import { DropType } from '@/entities/IDrop';
import { EntryManifest } from './waves-chain-mirror.docs';
import { isReleasedEntry } from './waves-chain-mirror.entries';
import { nativeEntryRowId } from './waves-chain-mirror.ids';
import { PlanCounter, timeOf } from './waves-chain-mirror.plan-support';
import {
  ChainDecisionState,
  ChainEntryRow,
  MirrorLookups,
  TargetCompetition,
  TargetCompetitionState,
  TargetEntry
} from './waves-chain-mirror.types';

/**
 * Entries made on the chain in an imported decision (drops and
 * competition_entries): a drop with id = the chain entry id, its content
 * from the entry manifest the chain committed to, and its competition entry.
 *
 * The chain checks hashes, not content. A manifest is used only once it is
 * checked (waves-chain-mirror.docs.ts) and its fields pass 6529.io's
 * create-drop validation (NewDropSchema, the part rules) for this wave;
 * pre-publication moderation runs before the service plans (write runs
 * only). An entry whose manifest fails is held back: the chain counts it,
 * 6529.io shows nothing of it, and the reason is reported. Attachments are
 * left out (they are uploads 6529.io checks against their uploader on the
 * create path).
 *
 * The drop is a COMPETITION drop, as v3 entries are (the legacy views show
 * PARTICIPATORY or WINNER for a wave's primary competition); `created_at` is
 * the entry's `createdMs`; `serial_no` is the insert order, not the chain's.
 */

/** A manifest's entry, as 6529.io's create path would store it. */
export interface NativeEntryContent {
  readonly title: string | null;
  readonly parts: {
    readonly content: string | null;
    readonly quotedDropId: string | null;
    readonly quotedDropPartId: number | null;
    readonly media: {
      readonly url: string;
      readonly mimeType: string;
      readonly mediaUploadId: string | null;
    }[];
  }[];
  readonly metadata: { readonly dataKey: string; readonly dataValue: string }[];
  readonly referencedNfts: {
    readonly contract: string;
    readonly token: string;
    readonly name: string;
  }[];
  readonly mentionedUsers: {
    readonly profileId: string;
    readonly handle: string;
  }[];
  readonly mentionedWaves: {
    readonly waveId: string;
    readonly name: string;
  }[];
  readonly mentionedGroups: string[];
  readonly hideLinkPreview: boolean;
  readonly isAdditionalActionPromised: boolean | null;
  /** Collaborators invited (Main Stage artwork), as the create path takes them. */
  readonly collaboratorIds: readonly string[];
  /** Parts' attachments left out. */
  readonly attachmentsLeftOut: number;
}

/** A decision's participation rules (competitions.participation_config). */
export interface ParticipationRules {
  readonly requiredMetadata: readonly { name: string; type: string | null }[];
  readonly requiredMedia: readonly string[];
  readonly anonymous: boolean;
}

export function participationRulesOf(
  config: Record<string, unknown>
): ParticipationRules {
  const list = (value: unknown): unknown[] => {
    const parsed = typeof value === 'string' ? safeJson(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  };
  return {
    requiredMetadata: list(config.required_metadata).flatMap((item) => {
      const name = (item as Record<string, unknown>)?.name;
      const type = (item as Record<string, unknown>)?.type;
      return typeof name === 'string'
        ? [{ name, type: typeof type === 'string' ? type : null }]
        : [];
    }),
    requiredMedia: list(config.required_media).filter(
      (item): item is string => typeof item === 'string'
    ),
    anonymous: config.anonymous_submissions === true
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const MEDIA_PREFIX: Record<string, string> = {
  IMAGE: 'image/',
  VIDEO: 'video/',
  AUDIO: 'audio/'
};

/** An older platform media URL that names its uploader (anonymous entries). */
function isOwnerIdentifyingPlatformMedia(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === CLOUDFRONT_LINK &&
      /^\/(?:drops|renditions\/drops)\/author_[^/]+\//i.test(
        decodeURIComponent(url.pathname)
      )
    );
  } catch {
    return false;
  }
}

export type NativeEntryLookup =
  | { readonly ok: true; readonly content: NativeEntryContent }
  | { readonly ok: false; readonly reason: string };

/**
 * A checked manifest's entry fields, validated as 6529.io validates a new
 * participatory drop in this competition's wave.
 */
export function nativeEntryContent(
  manifest: EntryManifest,
  competition: Pick<TargetCompetition, 'waveId'> & {
    readonly rules?: ParticipationRules;
  }
): NativeEntryLookup {
  const rules = competition.rules ?? {
    requiredMetadata: [],
    requiredMedia: [],
    anonymous: false
  };
  const fields = manifest.fields;
  if (fields.wave_id !== competition.waveId) {
    return { ok: false, reason: 'wave_mismatch' };
  }
  if (fields.poll !== undefined) return { ok: false, reason: 'poll_in_entry' };
  const { error, value } = NewDropSchema.validate(
    { ...fields, drop_type: ApiDropType.Participatory },
    { abortEarly: true }
  );
  if (error) return { ok: false, reason: 'invalid_content' };
  const drop = value as ApiCreateDropRequest;
  // Decision entries are neither replies nor quotes (assertCompetitionEntryContent).
  if (drop.reply_to || drop.parts.some((part) => part.quoted_drop)) {
    return { ok: false, reason: 'quote_or_reply_in_entry' };
  }
  // Attachments are left out, so a part needs content or media itself.
  if (
    drop.parts.some(
      (part) => !part.content?.trim() && (part.media ?? []).length === 0
    )
  ) {
    return { ok: false, reason: 'empty_part' };
  }
  const metadata = drop.metadata ?? [];
  for (const required of rules.requiredMetadata) {
    const values = metadata.filter((item) => item.data_key === required.name);
    if (!values.length) return { ok: false, reason: 'required_metadata' };
    if (
      required.type === 'NUMBER' &&
      !values.some((item) => numbers.parseIntOrNull(item.data_value) !== null)
    ) {
      return { ok: false, reason: 'required_metadata' };
    }
  }
  const allMedia = drop.parts.flatMap((part) => part.media ?? []);
  for (const required of rules.requiredMedia) {
    const prefix = MEDIA_PREFIX[required];
    if (!prefix || !allMedia.some((m) => m.mime_type.startsWith(prefix))) {
      return { ok: false, reason: 'required_media' };
    }
  }
  if (
    rules.anonymous &&
    allMedia.some((m) => isOwnerIdentifyingPlatformMedia(m.url))
  ) {
    return { ok: false, reason: 'anonymous_media_reupload' };
  }
  let attachmentsLeftOut = 0;
  const parts = drop.parts.map((part) => {
    attachmentsLeftOut += (part.attachments ?? []).length;
    return {
      content: part.content ?? null,
      quotedDropId: part.quoted_drop?.drop_id ?? null,
      quotedDropPartId: part.quoted_drop?.drop_part_id ?? null,
      media: (part.media ?? []).map((media) => ({
        url: media.url,
        mimeType: media.mime_type,
        mediaUploadId: media.media_upload_id ?? null
      }))
    };
  });
  return {
    ok: true,
    content: {
      title: drop.title ?? null,
      parts,
      metadata: (drop.metadata ?? []).map((m) => ({
        dataKey: m.data_key,
        dataValue: m.data_value
      })),
      referencedNfts: Array.from(
        new Map(
          (drop.referenced_nfts ?? []).map((nft) => [
            JSON.stringify([nft.contract, nft.token, nft.name]),
            { contract: nft.contract, token: nft.token, name: nft.name }
          ])
        ).values()
      ),
      mentionedUsers: (drop.mentioned_users ?? []).flatMap((user) =>
        user.mentioned_profile_id
          ? [
              {
                profileId: user.mentioned_profile_id,
                handle: user.handle_in_content
              }
            ]
          : []
      ),
      mentionedWaves: (drop.mentioned_waves ?? []).map((wave) => ({
        waveId: wave.wave_id,
        name: wave.wave_name_in_content
      })),
      mentionedGroups: Array.from(
        new Set((drop.mentioned_groups ?? []).map(String))
      ),
      hideLinkPreview: !!drop.hide_link_preview,
      isAdditionalActionPromised: drop.is_additional_action_promised ?? null,
      collaboratorIds: drop.collaborator_ids ?? [],
      attachmentsLeftOut
    }
  };
}

export interface NativeEntryWrite {
  readonly entryRowId: string;
  readonly dropId: string;
  readonly waveId: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly configVersion: number;
  readonly content: NativeEntryContent;
}

/**
 * The chain entries made on the chain that 6529.io has no row of yet. One
 * the chain withdrew or disqualified before 6529.io had it is never written
 * (6529.io would have deleted it); a winner is written ACTIVE, and the
 * result makes it WINNER.
 */
export function nativeEntriesToWrite(
  chain: ChainDecisionState,
  target: Pick<TargetCompetitionState, 'entries'>
): ChainEntryRow[] {
  const drops = new Set(target.entries.map((e) => e.dropId.toLowerCase()));
  return chain.entries.filter(
    (e) => e.legacyId === null && !isReleasedEntry(e) && !drops.has(e.entryId)
  );
}

/**
 * The drops and entries of entries made on the chain. Each written entry
 * joins `entries`, so the plan's votes, board and results take it in the
 * same run.
 */
export function planNativeEntries(input: {
  readonly chain: ChainDecisionState;
  readonly target: TargetCompetitionState;
  readonly lookups: MirrorLookups;
  readonly entries: Map<string, TargetEntry>;
  readonly counter: PlanCounter;
}): NativeEntryWrite[] {
  const { chain, target, lookups, entries, counter } = input;
  const out: NativeEntryWrite[] = [];
  const configVersion = Number(chain.decision.data.configVersion ?? 1) || 1;
  for (const entry of nativeEntriesToWrite(chain, target)) {
    const authorId = lookups.profileOf(entry.author);
    if (!authorId) {
      counter.wait('native_entry_author_unmapped');
      continue;
    }
    const found = lookups.nativeEntry(entry.entryId);
    if (!found) {
      counter.wait('native_entry_manifest_missing');
      continue;
    }
    if (!found.ok) {
      counter.wait(`native_entry_held_${found.reason}`);
      continue;
    }
    const createdAt = timeOf(entry.data.createdMs);
    if (createdAt === null) {
      counter.wait('native_entry_without_time');
      continue;
    }
    const write: NativeEntryWrite = {
      entryRowId: nativeEntryRowId(target.competition.id, entry.entryId),
      dropId: entry.entryId,
      waveId: target.competition.waveId,
      authorId,
      createdAt,
      configVersion,
      content: found.content
    };
    out.push(write);
    counter.change('drops', 'insert');
    counter.change('competition_entries', 'insert');
    counter.wait(
      'native_entry_attachments_left_out',
      found.content.attachmentsLeftOut
    );
    entries.set(entry.entryId, {
      id: write.entryRowId,
      dropId: write.dropId,
      submitterId: authorId,
      status: 'ACTIVE',
      configVersion,
      submittedAt: createdAt,
      withdrawnAt: null,
      disqualifiedAt: null,
      wonAt: null,
      rank: null,
      decisionId: null
    });
  }
  return out;
}

/** The drop row a native entry's write inserts. */
export function nativeEntryDrop(write: NativeEntryWrite) {
  return {
    id: write.dropId,
    author_id: write.authorId,
    drop_type: DropType.COMPETITION,
    wave_id: write.waveId,
    created_at: write.createdAt,
    updated_at: null,
    title: write.content.title,
    parts_count: write.content.parts.length,
    signature: null,
    is_additional_action_promised: write.content.isAdditionalActionPromised,
    hide_link_preview: write.content.hideLinkPreview,
    collapse_replies: false,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    serial_no: null
  };
}
