import {
  currentCollaborationInvitations,
  validateCollaborationInvitees
} from './meme-collaboration-invitation-policy';
import { formatMemeArtistNames } from './meme-collaboration-credit';
import { competitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import { createHash, randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import {
  DROPS_TABLE,
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  MEME_COLLABORATIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE,
  COMPETITIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import {
  MemeCollaborationCredit,
  MemeCollaborationArtwork,
  MemeCollaborationEntity
} from '@/entities/IMemeCollaboration';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  CustomApiCompliantException
} from '@/exceptions';
import { userNotifier } from '@/notifications/user.notifier';
import { RequestContext } from '@/request.context';
import { canonicalJSONStringify } from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  CollaborationInvitation,
  MemeCollaborationsDb,
  memeCollaborationsDb
} from './meme-collaborations.db';

const INVITATION_RESPONSE_STATUS = {
  ACCEPT: 'ACCEPTED',
  DECLINE: 'DECLINED',
  CANCEL: 'CANCELLED'
} as const;

export const COLLABORATION_COPY_VERSION = '2';
export const COLLABORATION_ACCEPTANCE_COPY =
  'I agree to be credited as a collaborating artist on this artwork and accept its submission and minting terms. Acceptance is final and cannot be withdrawn. It does not grant editing rights or establish payment splits. If I accept before this artwork is selected for minting, my credit will be included in the initial minting claim. Admins can edit the final mint artwork and credits in Drop Forge.';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function collaborationArtworkDetails(
  model: Pick<CreateOrUpdateDropModel, 'title' | 'parts' | 'metadata'>
): MemeCollaborationArtwork {
  const media = model.parts.flatMap((part) => part.media);
  const primary =
    media.find((item) => item.mime_type.toLowerCase() === 'text/html') ??
    media.find((item) => item.mime_type.toLowerCase().startsWith('video/')) ??
    media.find((item) => item.mime_type.toLowerCase().startsWith('image/')) ??
    media.find((item) => item.mime_type.toLowerCase() === 'model/gltf-binary');
  const additional = model.metadata.find(
    (item) => item.data_key === 'additional_media'
  )?.data_value;
  let preview: string | null = null;
  if (additional) {
    try {
      const parsed = JSON.parse(additional) as { preview_image?: unknown };
      if (typeof parsed?.preview_image === 'string')
        preview = parsed.preview_image || null;
    } catch {
      throw new BadRequestException('Invalid artwork preview metadata');
    }
  }
  const image = primary?.mime_type.toLowerCase().startsWith('image/');
  return {
    name:
      model.metadata
        .find((item) => item.data_key === 'title')
        ?.data_value.trim() ??
      model.title?.trim() ??
      '',
    description:
      model.metadata
        .find((item) => item.data_key === 'description')
        ?.data_value.trim() ??
      model.parts[0]?.content?.trim() ??
      '',
    image_url: image ? primary!.url.trim() : preview,
    animation_url: !image && primary ? primary.url.trim() : null
  };
}

export function collaborationArtworkHash(
  model: Pick<CreateOrUpdateDropModel, 'title' | 'parts' | 'metadata'>
): string {
  return hash(
    canonicalJSONStringify({
      ...collaborationArtworkDetails(model),
      artist:
        model.metadata
          .find((item) => item.data_key === 'artist')
          ?.data_value.trim() ?? ''
    })
  );
}

export function buildCollaborationCredit(
  artist: string,
  authorHandle: string,
  invitations: CollaborationInvitation[]
): MemeCollaborationCredit {
  const accepted = invitations.filter((item) => item.status === 'ACCEPTED');
  if (!authorHandle || accepted.some((item) => !item.profile.handle))
    throw new BadRequestException(
      'All credited artists must have an available profile'
    );
  return {
    artist: formatMemeArtistNames([
      artist,
      ...accepted.map((item) => item.artist_name || item.profile.display)
    ]),
    artist_profiles: [
      authorHandle,
      ...accepted.map((item) => item.profile.handle)
    ].join(', '),
    collab: accepted.length > 0
  };
}

function responseArtistName(
  action: string,
  suppliedName: string | undefined,
  profileHandle: string
): string | null {
  if (action !== 'ACCEPT') return null;
  const name = (suppliedName ?? profileHandle).trim();
  if (!name || name.length > 200)
    throw new BadRequestException(
      'Artist credit name must be 1–200 characters'
    );
  return name;
}

export class MemeCollaborationsService {
  constructor(
    private readonly db: MemeCollaborationsDb = memeCollaborationsDb
  ) {}

  async onWrite(
    model: CreateOrUpdateDropModel,
    dropId: string,
    ctx: RequestContext,
    competitionId?: string
  ): Promise<number[]> {
    if (model.drop_id && model.collaborator_ids !== undefined)
      throw new BadRequestException(
        'Collaborator invitations can only be set when submitting a new artwork'
      );
    const artworkSubmission =
      [DropType.PARTICIPATORY, DropType.COMPETITION].includes(
        model.drop_type
      ) &&
      model.metadata.some((item) => item.data_key === 'memeName') &&
      model.parts.some((part) => part.media.length);
    if (
      !model.drop_id &&
      !artworkSubmission &&
      model.collaborator_ids === undefined
    )
      return [];
    const existing = await this.db.context(dropId, ctx, true);
    if (existing) {
      await this.updateArtwork(model, existing, ctx);
      return [];
    }
    if (model.drop_id && model.collaborator_ids === undefined) return [];
    if (model.drop_id || !artworkSubmission)
      throw new BadRequestException(
        'Collaborator invitations require a new artwork submission'
      );
    if (model.proxy_id && model.collaborator_ids?.length)
      throw new ForbiddenException(
        'Submit collaborator invitations directly from your own profile'
      );
    const ids = model.collaborator_ids ?? [];
    validateCollaborationInvitees(ids, model.author_id!);
    if (
      !competitionId ||
      !(await competitionMainStageRepository.isDesignated(competitionId, ctx))
    ) {
      if (ids.length)
        throw new BadRequestException(
          'Invitations require a Memes Main Stage submission'
        );
      return [];
    }
    return this.createInvitations(model, dropId, ids, ctx, competitionId);
  }

  async inviteExisting(
    dropId: string,
    ids: string[],
    auth: AuthenticationContext,
    ctx: RequestContext
  ): Promise<number[]> {
    if (
      !auth.authenticatedProfileId ||
      auth.isAuthenticatedAsProxy() ||
      !auth.authenticatedWallet
    )
      throw new ForbiddenException(
        'Invite directly using your own authenticated profile'
      );
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const tx = { ...ctx, connection };
      // Also acquired by mint selection, including submissions predating managed contexts.
      const [drop] = await this.db.query<{
        author_id: string;
        wave_id: string;
        title: string | null;
      }>(
        'lockArtwork',
        `select author_id,wave_id,title from ${DROPS_TABLE} where id=:dropId for update`,
        { dropId },
        tx
      );
      if (!drop) throw new NotFoundException('Submission no longer exists');
      if (drop.author_id !== auth.authenticatedProfileId)
        throw new ForbiddenException(
          'Only the submitter can invite collaborators'
        );
      let context = await this.db.context(dropId, tx, true);
      const eligible = await this.db.activeMainStageDrop(dropId, tx);
      if (!eligible || context?.closed_at != null)
        throw new BadRequestException(
          'Invitations require an active Memes Main Stage submission'
        );
      const previous = context ? await this.db.invitations(dropId, tx) : [];
      if (!ids.length)
        throw new BadRequestException('Choose at least one collaborator');
      validateCollaborationInvitees(ids, drop.author_id, previous);
      if (!context) {
        const model = await this.existingArtworkModel(dropId, drop, tx);
        await this.createInvitations(
          model,
          dropId,
          [],
          tx,
          eligible.competition_id
        );
        context = await this.db.context(dropId, tx, true);
      }
      if (!context) throw new NotFoundException('Collaboration not found');
      return this.insertInvitations(
        context.author_id,
        context.wave_id,
        dropId,
        ids,
        tx,
        context.artwork.name,
        previous.reduce(
          (latest, item) => Math.max(latest, Number(item.created_at) || 0),
          0
        )
      );
    });
  }

  private async existingArtworkModel(
    dropId: string,
    drop: { author_id: string; wave_id: string; title: string | null },
    ctx: RequestContext
  ) {
    const metadata = await this.db.query<
      CreateOrUpdateDropModel['metadata'][number]
    >(
      'artworkMetadata',
      `select data_key,data_value from ${DROP_METADATA_TABLE} where drop_id=:dropId`,
      { dropId },
      ctx
    );
    const parts = await this.db.query<{ content: string | null }>(
      'artworkParts',
      `select content from ${DROPS_PARTS_TABLE} where drop_id=:dropId order by drop_part_id`,
      { dropId },
      ctx
    );
    const media = await this.db.query<{ url: string; mime_type: string }>(
      'artworkMedia',
      `select url,mime_type from ${DROP_MEDIA_TABLE} where drop_id=:dropId order by drop_part_id,id`,
      { dropId },
      ctx
    );
    if (!metadata.some((item) => item.data_key === 'memeName') || !media.length)
      throw new BadRequestException(
        'Invitations require an artwork submission'
      );
    const model = {
      ...drop,
      metadata,
      title: drop.title,
      parts: parts.map((part, index) => ({
        ...part,
        quoted_drop: null,
        media: index === 0 ? media : []
      }))
    };
    return model;
  }

  private async updateArtwork(
    model: CreateOrUpdateDropModel,
    existing: MemeCollaborationEntity,
    ctx: RequestContext
  ): Promise<void> {
    const dropId = existing.drop_id;
    const artworkHash = collaborationArtworkHash(model);
    const artwork = collaborationArtworkDetails(model);
    if (existing.artwork_hash !== artworkHash) {
      const accepted = (await this.db.invitations(dropId, ctx)).filter(
        (item) => item.status === 'ACCEPTED'
      );
      const presentedArtist =
        existing.credit?.artist ??
        formatMemeArtistNames([
          existing.base_artist,
          ...accepted.map((item) => item.artist_name || item.profile.display)
        ]);
      const incomingArtist = model.metadata
        .find((item) => item.data_key === 'artist')
        ?.data_value.trim();
      // API reads expose combined credits; an unchanged read/write round trip
      // must not be interpreted as replacing the submitter's artist name.
      if (
        incomingArtist === presentedArtist &&
        collaborationArtworkHash({
          ...model,
          metadata: model.metadata.map((item) =>
            item.data_key === 'artist'
              ? { ...item, data_value: existing.base_artist }
              : item
          )
        }) === existing.artwork_hash
      )
        return;
      if (accepted.length > 0 || existing.closed_at !== null)
        throw new BadRequestException(
          'Collaborator consent locks this artwork and artist credit. Create a new submission to replace it.'
        );
      await this.db.query(
        'updateArtwork',
        `update ${MEME_COLLABORATIONS_TABLE} set artwork_hash=:artworkHash, artwork=:artwork, base_artist=:artist where drop_id=:dropId`,
        {
          dropId,
          artworkHash,
          artwork: JSON.stringify(artwork),
          artist:
            model.metadata
              .find((item) => item.data_key === 'artist')
              ?.data_value.trim() ?? ''
        },
        ctx
      );
    }
  }

  private async createInvitations(
    model: Pick<
      CreateOrUpdateDropModel,
      'author_id' | 'wave_id' | 'title' | 'parts' | 'metadata'
    >,
    dropId: string,
    ids: string[],
    ctx: RequestContext,
    competitionId: string
  ): Promise<number[]> {
    const artworkHash = collaborationArtworkHash(model);
    const artwork = collaborationArtworkDetails(model);
    const profiles = await this.db.profiles([model.author_id!, ...ids], ctx);
    if (
      profiles.length !== ids.length + 1 ||
      profiles.some((profile) => !profile.handle)
    )
      throw new BadRequestException(
        'All collaborating artists must have an available profile'
      );
    const [wave] = await this.db.query<{
      visibility_group_id: string | null;
    }>(
      'wave',
      `select visibility_group_id from ${WAVES_TABLE} where id=:id`,
      { id: model.wave_id },
      ctx
    );
    if (!wave) throw new NotFoundException('Wave not found');
    const [competition] = await this.db.query<{
      participation_config: string | { terms?: string | null };
    }>(
      'competitionTerms',
      `select participation_config from ${COMPETITIONS_TABLE} where id=:id and wave_id=:waveId`,
      { id: competitionId, waveId: model.wave_id },
      ctx
    );
    if (!competition) throw new NotFoundException('Competition not found');
    const config =
      typeof competition.participation_config === 'string'
        ? JSON.parse(competition.participation_config)
        : competition.participation_config;
    const terms = config.terms ?? null;
    const termsVersion = hash(`${COLLABORATION_COPY_VERSION}:${terms ?? ''}`);
    await this.db.query(
      'createContext',
      `insert into ${MEME_COLLABORATIONS_TABLE} (drop_id,author_id,author_handle,wave_id,artwork_hash,artwork,base_artist,terms,terms_version,closed_at,credit) values (:dropId,:authorId,:authorHandle,:waveId,:artworkHash,:artwork,:artist,:terms,:termsVersion,null,null)`,
      {
        dropId,
        authorId: model.author_id,
        authorHandle: profiles.find(
          (profile) => profile.id === model.author_id
        )!.handle,
        waveId: model.wave_id,
        artworkHash,
        artwork: JSON.stringify(artwork),
        artist:
          model.metadata
            .find((item) => item.data_key === 'artist')
            ?.data_value.trim() ?? '',
        terms,
        termsVersion
      },
      ctx
    );
    return this.insertInvitations(
      model.author_id!,
      model.wave_id,
      dropId,
      ids,
      ctx,
      artwork.name
    );
  }

  private async insertInvitations(
    authorId: string,
    waveId: string,
    dropId: string,
    ids: string[],
    ctx: RequestContext,
    artworkName: string,
    previousCreatedAt = 0
  ): Promise<number[]> {
    if (!ids.length) return [];
    const profiles = await this.db.profiles(ids, ctx);
    if (
      profiles.length !== ids.length ||
      profiles.some((profile) => !profile.handle)
    )
      throw new BadRequestException(
        'All collaborating artists must have an available profile'
      );
    const [wave] = await this.db.query<{ visibility_group_id: string | null }>(
      'invitationWave',
      `select visibility_group_id from ${WAVES_TABLE} where id=:id`,
      { id: waveId },
      ctx
    );
    if (!wave) throw new NotFoundException('Wave not found');
    const handles = new Map(
      profiles.map((profile) => [profile.id, profile.handle])
    );
    const invitations = ids.map((profileId) => ({
      id: randomUUID(),
      profileId,
      profileHandle: handles.get(profileId)!,
      now: Math.max(Date.now(), previousCreatedAt + 1)
    }));
    const params: Record<string, unknown> = { dropId };
    const values = invitations.map((invitation, index) => {
      params[`id${index}`] = invitation.id;
      params[`profileId${index}`] = invitation.profileId;
      params[`profileHandle${index}`] = invitation.profileHandle;
      params[`now${index}`] = invitation.now;
      return `(:id${index},:dropId,:profileId${index},:profileHandle${index},'PENDING',:now${index},null,null,null)`;
    });
    // Persist the full roster before its dependent notifications on the same transaction.
    await this.db.query(
      'invite',
      `insert into ${MEME_COLLABORATION_INVITATIONS_TABLE} (id,drop_id,profile_id,profile_handle,status,created_at,responded_at,responder_wallet,acceptance_copy_version) values ${values.join(',')}`,
      params,
      ctx
    );
    return userNotifier.notifyOfMemeCollaborations(
      invitations.map((invitation) => ({
        recipientId: invitation.profileId,
        data: {
          event_type: 'INVITED',
          artwork_name: artworkName,
          drop_id: dropId,
          wave_id: waveId,
          actor_id: authorId,
          invitation_id: invitation.id
        }
      })),
      wave.visibility_group_id,
      ctx
    );
  }

  async state(dropId: string, viewerId: string | null, ctx: RequestContext) {
    const context = await this.db.context(dropId, ctx);
    const invitations = currentCollaborationInvitations(
      context ? await this.db.invitations(dropId, ctx) : []
    );
    return {
      can_invite:
        !!viewerId &&
        !ctx.authenticationContext?.isAuthenticatedAsProxy() &&
        context?.closed_at == null &&
        (await this.db.activeMainStageDrop(dropId, ctx))?.author_id ===
          viewerId,
      managed: !!context,
      closed: context?.closed_at != null,
      artwork_hash: context?.artwork_hash ?? '',
      terms_version: context?.terms_version ?? '',
      acceptance_copy: COLLABORATION_ACCEPTANCE_COPY,
      terms: context?.terms ?? null,
      artwork: context?.artwork,
      collaborators: invitations
        .filter((item) => item.status === 'ACCEPTED')
        .map((item) => ({
          ...item.profile,
          display: item.artist_name || item.profile.display
        })),
      invitations: invitations
        .filter(
          (item) =>
            context?.author_id === viewerId || item.profile_id === viewerId
        )
        .map((item) => ({
          id: item.id,
          profile: item.profile,
          artist_name: item.artist_name ?? null,
          status: item.status
        }))
    };
  }

  async respond(
    dropId: string,
    invitationId: string,
    body: {
      action: 'ACCEPT' | 'DECLINE' | 'CANCEL';
      artwork_hash: string;
      terms_version: string;
      artist_name?: string;
    },
    auth: AuthenticationContext,
    ctx: RequestContext
  ): Promise<number[]> {
    if (
      !auth.authenticatedProfileId ||
      auth.isAuthenticatedAsProxy() ||
      !auth.authenticatedWallet
    )
      throw new ForbiddenException(
        'Respond directly using your own authenticated profile'
      );
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const tx = { ...ctx, connection };
      const context = await this.db.context(dropId, tx, true);
      if (!context) throw new NotFoundException('Collaboration not found');
      const invitation = (await this.db.invitations(dropId, tx)).find(
        (item) => item.id === invitationId
      );
      if (!invitation) throw new NotFoundException('Invitation not found');
      const actor = auth.authenticatedProfileId!;
      if (
        body.action === 'CANCEL'
          ? context.author_id !== actor
          : invitation.profile_id !== actor
      )
        throw new ForbiddenException(
          'This invitation belongs to another profile'
        );
      if (
        body.artwork_hash !== context.artwork_hash ||
        body.terms_version !== context.terms_version
      )
        throw new CustomApiCompliantException(
          409,
          'Artwork or terms changed. Review the invitation again.'
        );
      const next = INVITATION_RESPONSE_STATUS[body.action];
      if (invitation.status === next) return [];
      if (context.closed_at !== null || invitation.status !== 'PENDING')
        throw new CustomApiCompliantException(
          409,
          'This invitation is closed. Accepted collaborations cannot be withdrawn.'
        );
      const artistName = responseArtistName(
        body.action,
        body.artist_name,
        invitation.profile.handle
      );
      const [drop] = await this.db.query<{ id: string }>(
        'dropExists',
        `select id from ${DROPS_TABLE} where id=:dropId`,
        { dropId },
        tx
      );
      if (!drop) throw new NotFoundException('Submission no longer exists');
      await this.db.query(
        'respond',
        `update ${MEME_COLLABORATION_INVITATIONS_TABLE} set status=:status,profile_handle=:profileHandle,artist_name=:artistName,responded_at=:now,responder_wallet=:wallet,acceptance_copy_version=:copyVersion where id=:id and status='PENDING'`,
        {
          id: invitationId,
          status: next,
          profileHandle: invitation.profile.handle,
          artistName,
          now: Date.now(),
          wallet: auth.authenticatedWallet,
          copyVersion:
            body.action === 'ACCEPT' ? COLLABORATION_COPY_VERSION : null
        },
        tx
      );
      if (body.action === 'DECLINE') return [];
      const [wave] = await this.db.query<{
        visibility_group_id: string | null;
      }>(
        'waveVisibility',
        `select visibility_group_id from ${WAVES_TABLE} where id=:id`,
        { id: context.wave_id },
        tx
      );
      return userNotifier.notifyOfMemeCollaboration(
        body.action === 'CANCEL' ? invitation.profile_id : context.author_id,
        {
          event_type: body.action === 'CANCEL' ? 'CANCELLED' : 'ACCEPTED',
          artwork_name: context.artwork.name,
          drop_id: dropId,
          wave_id: context.wave_id,
          actor_id: actor,
          invitation_id: invitationId
        },
        wave?.visibility_group_id ?? null,
        tx
      );
    });
  }

  async freezeForMint(
    dropId: string,
    ctx: RequestContext
  ): Promise<MemeCollaborationCredit | null> {
    await this.db.query(
      'lockMintArtwork',
      `select id from ${DROPS_TABLE} where id=:dropId for update`,
      { dropId },
      ctx
    );
    const context = await this.db.context(dropId, ctx, true);
    if (!context) return null;
    if (context.credit) return context.credit;
    const invitations = await this.db.invitations(dropId, ctx);
    const [author] = await this.db.profiles([context.author_id], ctx);
    const credit = buildCollaborationCredit(
      context.base_artist,
      author?.handle || context.author_handle,
      invitations
    );
    await this.db.query(
      'freeze',
      `update ${MEME_COLLABORATIONS_TABLE} set closed_at=:now,credit=:credit where drop_id=:dropId`,
      { dropId, now: Date.now(), credit: JSON.stringify(credit) },
      ctx
    );
    await this.db.query(
      'closePending',
      `update ${MEME_COLLABORATION_INVITATIONS_TABLE} set status='CLOSED',responded_at=:now where drop_id=:dropId and status='PENDING'`,
      { dropId, now: Date.now() },
      ctx
    );
    return credit;
  }

  async closeDeleted(dropId: string, ctx: RequestContext): Promise<void> {
    if (!(await this.db.context(dropId, ctx, true))) return;
    await this.db.query(
      'closeDeleted',
      `update ${MEME_COLLABORATIONS_TABLE} set closed_at=coalesce(closed_at,:now) where drop_id=:dropId`,
      { dropId, now: Date.now() },
      ctx
    );
    await this.db.query(
      'cancelDeleted',
      `update ${MEME_COLLABORATION_INVITATIONS_TABLE} set status='CANCELLED',responded_at=:now where drop_id=:dropId and status='PENDING'`,
      { dropId, now: Date.now() },
      ctx
    );
  }
}

export const memeCollaborationsService = new MemeCollaborationsService();
