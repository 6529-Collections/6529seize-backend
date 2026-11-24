import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { dropSignatureVerifier } from '@/api/drops/drop-signature-verifier';
import {
  getStructuredWalletSignatureAudienceForHost,
  verifyWalletMessageSignature
} from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  canonicalCompetitionJson,
  competitionPayloadHash
} from '@/competitions/competition-command-identity';
import {
  ADDRESS_CONSOLIDATION_KEY,
  DROP_MEDIA_UPLOADS_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import { getPublishedDropMediaMimeType } from '@/drops/drop-media-upload.config';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { validateCollaborationInvitees } from '@/meme-collaborations/meme-collaboration-invitation-policy';
import { SqlExecutor } from '@/sql-executor';
import { EntryManifest } from './waves-chain-mirror.docs';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';

/**
 * The participation checks 6529.io makes on its own create path, for an
 * entry made on the chain, once its manifest has passed the content checks
 * (waves-chain-mirror.native-entries.ts):
 *
 * - consent: the wave's participation signature when the decision asks for
 *   one (or the manifest carries one), checked as 6529.io checks it: a drop
 *   signature ("6529-drop") with DropSignatureVerifier over the entry, the
 *   signer's fields and the wave's terms; a decision signature
 *   ("6529-competition-v1") over the same envelope 6529.io's ENTRY_CREATE
 *   signs. The signer must be one of the author's wallets. The envelope's
 *   5-minute window and nonce are not checked: the chain's submission is
 *   itself signed and counted once, and the payload hash binds the entry.
 * - media: a media upload id must be the author's own upload of that URL
 *   and type, in a state 6529.io lets a drop attach (as
 *   verifyDropMediaUploadReference).
 * - mentions: profiles are looked up by the handles in the content, as the
 *   create path does; the ids the manifest names are not taken.
 * - collaborators: distinct, not the author, each with a profile and a
 *   handle, and only on the designated Main Stage (as
 *   MemeCollaborationsService.onWrite asks).
 * Each failure holds the entry back with its reason.
 */

export interface EntryCheckContext {
  readonly competitionId: string;
  readonly waveId: string;
  readonly waveName: string | null;
  /** The wave's participation terms. */
  readonly terms: string | null;
  readonly signatureRequired: boolean;
  /** The competition is the designated Main Stage. */
  readonly mainStage: boolean;
}

export type EntryCheck =
  | { readonly ok: true; readonly content: NativeEntryContent }
  | { readonly ok: false; readonly reason: string };

export interface EntryChecker {
  check(input: {
    readonly manifest: EntryManifest;
    readonly content: NativeEntryContent;
    readonly authorProfileId: string;
    readonly context: EntryCheckContext;
  }): Promise<EntryCheck>;
}

/** What the checks read from 6529.io. */
export interface EntryCheckReads {
  walletsOfProfile(profileId: string): Promise<string[]>;
  profileIdsByHandles(handles: readonly string[]): Promise<Map<string, string>>;
  profileHandles(profileIds: readonly string[]): Promise<Map<string, string>>;
  mediaUpload(id: string): Promise<{
    profileId: string;
    publicUrl: string | null;
    declaredMimeType: string;
    status: string;
  } | null>;
}

const ATTACHABLE_UPLOAD_STATUSES: ReadonlySet<string> = new Set([
  DropMediaUploadStatus.PROCESSING,
  DropMediaUploadStatus.SANITIZING,
  DropMediaUploadStatus.READY
]);

type Consent = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export class ParticipationEntryChecker implements EntryChecker {
  constructor(
    private readonly reads: EntryCheckReads,
    private readonly verifyDrop: typeof dropSignatureVerifier.isDropSignedByAnyOfGivenWallets = (
      args
    ) => dropSignatureVerifier.isDropSignedByAnyOfGivenWallets(args),
    private readonly verifyMessage: typeof verifyWalletMessageSignature = verifyWalletMessageSignature
  ) {}

  async check(input: {
    readonly manifest: EntryManifest;
    readonly content: NativeEntryContent;
    readonly authorProfileId: string;
    readonly context: EntryCheckContext;
  }): Promise<EntryCheck> {
    const { manifest, content, authorProfileId, context } = input;
    const consent = manifest.consent;
    if (!consent) {
      if (context.signatureRequired) {
        return { ok: false, reason: 'consent_missing' };
      }
    } else if (
      !(await this.consentHolds(consent, manifest, authorProfileId, context))
    ) {
      return { ok: false, reason: 'consent_invalid' };
    }
    for (const media of content.parts.flatMap((part) => part.media)) {
      if (!media.mediaUploadId) continue;
      const upload = await this.reads.mediaUpload(media.mediaUploadId);
      const mimeType =
        media.mimeType === 'image/jpg' ? 'image/jpeg' : media.mimeType;
      if (
        !upload ||
        upload.publicUrl !== media.url ||
        getPublishedDropMediaMimeType(upload.declaredMimeType) !== mimeType ||
        upload.profileId !== authorProfileId ||
        !ATTACHABLE_UPLOAD_STATUSES.has(upload.status)
      ) {
        return { ok: false, reason: 'media_upload_invalid' };
      }
    }
    const collaborators = content.collaboratorIds;
    if (collaborators.length) {
      if (!context.mainStage) {
        return { ok: false, reason: 'collaborators_outside_main_stage' };
      }
      try {
        validateCollaborationInvitees([...collaborators], authorProfileId);
      } catch {
        return { ok: false, reason: 'collaborators_invalid' };
      }
      const handles = await this.reads.profileHandles([
        authorProfileId,
        ...collaborators
      ]);
      if (handles.size !== collaborators.length + 1) {
        return { ok: false, reason: 'collaborators_invalid' };
      }
    }
    // Mentions: the profiles of the handles in the content.
    const byHandle = await this.reads.profileIdsByHandles(
      content.mentionedUsers.map((user) => user.handle)
    );
    const mentionedUsers = Array.from(byHandle.entries()).map(
      ([handle, profileId]) => ({ profileId, handle })
    );
    return { ok: true, content: { ...content, mentionedUsers } };
  }

  private async consentHolds(
    consent: Consent,
    manifest: EntryManifest,
    authorProfileId: string,
    context: EntryCheckContext
  ): Promise<boolean> {
    const signature = text(consent.signature);
    const signer = text(consent.signer_address)?.toLowerCase() ?? null;
    if (!signature || !signer) return false;
    const wallets = (await this.reads.walletsOfProfile(authorProfileId)).map(
      (wallet) => wallet.toLowerCase()
    );
    if (!wallets.includes(signer)) return false;
    if (consent.scheme === '6529-drop') {
      const message = text(consent.signature_message);
      const drop = {
        ...manifest.fields,
        ...(consent.client_drop_id === null ||
        consent.client_drop_id === undefined
          ? {}
          : { client_drop_id: consent.client_drop_id }),
        signer_address: signer,
        ...(consent.is_safe_signature === null ||
        consent.is_safe_signature === undefined
          ? {}
          : { is_safe_signature: consent.is_safe_signature }),
        signature,
        signature_message: message
      } as unknown as ApiCreateDropRequest;
      return this.verifyDrop({
        wallets: [signer],
        drop,
        termsOfService: context.terms,
        waveName: context.waveName,
        audience: message ? typedAudience(message) : null
      });
    }
    if (consent.scheme === '6529-competition-v1') {
      const message = text(consent.signature_message);
      if (!message) return false;
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(message) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        typeof envelope.audience !== 'string' ||
        typeof envelope.config_version !== 'number'
      ) {
        return false;
      }
      const expected = canonicalCompetitionJson({
        domain: '6529-competition-v1',
        audience: envelope.audience,
        chain_id: 1,
        action: 'ENTRY_CREATE',
        wave_id: context.waveId,
        competition_id: context.competitionId,
        competition_entry_id: null,
        drop_id: null,
        config_version: envelope.config_version,
        actor_profile_id: authorProfileId,
        actor_wallet: signer,
        payload_hash: competitionPayloadHash({
          drop: { ...manifest.fields, signature: null },
          drop_id: null
        }),
        nonce: envelope.nonce,
        issued_at: envelope.issued_at,
        expires_at: envelope.expires_at
      });
      if (message !== expected) return false;
      return (
        (await this.verifyMessage({
          message,
          signature,
          expectedAddress: signer,
          chainId: 1
        })) === signer
      );
    }
    return false;
  }
}

/** The audience a typed (Memes) drop signature names, if 6529.io allows it. */
function typedAudience(message: string): string | null {
  try {
    const parsed = JSON.parse(message) as {
      Verification?: { Audience?: unknown };
    };
    return getStructuredWalletSignatureAudienceForHost(
      parsed?.Verification?.Audience
    );
  } catch {
    return null;
  }
}

/** The checks' reads, from 6529.io's tables. */
export function entryCheckReads(db: () => SqlExecutor): EntryCheckReads {
  return {
    async walletsOfProfile(profileId) {
      const rows = await db().execute<{ address: string }>(
        `select ack.address from ${IDENTITIES_TABLE} i
           join ${ADDRESS_CONSOLIDATION_KEY} ack
             on ack.consolidation_key = i.consolidation_key
          where i.profile_id = :profileId`,
        { profileId }
      );
      return rows.map((row) => row.address);
    },
    async profileIdsByHandles(handles) {
      if (!handles.length) return new Map();
      const rows = await db().execute<{ profile_id: string; handle: string }>(
        `select profile_id, handle from ${IDENTITIES_TABLE}
          where normalised_handle in (:handles)`,
        { handles: handles.map((handle) => handle.toLowerCase()) }
      );
      return new Map(rows.map((row) => [row.handle, row.profile_id]));
    },
    async profileHandles(profileIds) {
      if (!profileIds.length) return new Map();
      const rows = await db().execute<{ profile_id: string; handle: string }>(
        `select profile_id, handle from ${IDENTITIES_TABLE}
          where profile_id in (:profileIds) and handle is not null`,
        { profileIds }
      );
      return new Map(rows.map((row) => [row.profile_id, row.handle]));
    },
    async mediaUpload(id) {
      const row = await db().oneOrNull<Record<string, unknown>>(
        `select profile_id, public_url, declared_mime_type, status
           from ${DROP_MEDIA_UPLOADS_TABLE} where id = :id`,
        { id }
      );
      return row
        ? {
            profileId: String(row.profile_id),
            publicUrl: text(row.public_url),
            declaredMimeType: String(row.declared_mime_type),
            status: String(row.status)
          }
        : null;
    }
  };
}
