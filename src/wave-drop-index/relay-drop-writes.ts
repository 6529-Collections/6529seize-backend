import { AuthenticationContext } from '@/auth-context';
import { parseAppDeviceGrantMessage } from '@/api/device-signing/app-device-grant';
import { DeviceEventKind } from '@/api/device-signing/device-event';
import { deviceSigningDb } from '@/api/device-signing/device-signing.db';
import {
  deviceSignedWritesService,
  SignedWriteContext
} from '@/api/device-signing/device-signed-writes.service';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { NewDropSchema, UpdateDropSchema } from '@/api/drops/drop.validator';
import { reactionsService } from '@/api/drops/reactions.service';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiUpdateDropRequest } from '@/api/generated/models/ApiUpdateDropRequest';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { parseSiweWebAuthMessage } from '@/api/wallet-signatures/siwe-wallet-auth';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { dropsDb } from '@/drops/drops.db';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { helpBotTriggerService } from '@/help-bot/help-bot-trigger.service';
import { identitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { Timer } from '@/time';
import { RelayDropWrites, RelayWriteInput } from './relay-drop-applier';

/**
 * The writes of relay-only drop events, as 6529.io's drop routes make them
 * (api-serverless drops.routes.ts: POST /drops, POST /drops/:id, DELETE
 * /drops/:id, POST and DELETE /drops/:id/reaction), for the author, with
 * the event's own device signature. The signature's grant counts at the
 * event's claimed time (SignedWriteContext.relaySignedAt).
 */

const logger = Logger.get('WAVE_DROP_INDEX_WRITES');

function contextOf(input: RelayWriteInput, timer: Timer): SignedWriteContext {
  return {
    timer,
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: input.event.author,
      authenticatedProfileId: input.profileId,
      roleProfileId: null,
      activeProxyActions: []
    }),
    relaySignedAt: input.envelope.claimed_time
  };
}

function issuedAtOf(message: string): number {
  if (message.startsWith('{')) {
    const parsed = parseAppDeviceGrantMessage(message);
    return parsed ? parsed.grant.issued_at * 1000 : 0;
  }
  return parseSiweWebAuthMessage(message)?.issuedAt.getTime() ?? 0;
}

export const relayDropWrites: RelayDropWrites = {
  profileIdOfWallet: (wallet) => identitiesDb.getProfileIdByWallet(wallet),

  async ensureGrant(proof) {
    const timer = new Timer('relay-drop-grant');
    const id = String(proof.id ?? '').toLowerCase();
    if (await deviceSigningDb.findGrantById(id, { timer })) return;
    const message = String(proof.message ?? '');
    // The event's check verified this grant (relay-event-check.ts); stored
    // like any grant, so 6529.io serves it with the drop's signed events
    // and the wallet's owner is told of the device.
    await deviceSigningDb.insertGrant(
      {
        id,
        wallet: String(proof.wallet ?? '').toLowerCase(),
        key_type: 'ed25519',
        device_key: String(proof.device_key ?? '').toLowerCase(),
        scopes: (Array.isArray(proof.scopes) ? proof.scopes : []).join(','),
        device_label: String(proof.domain ?? '').slice(0, 48) || 'Relay',
        domain: String(proof.domain ?? ''),
        message,
        wallet_signature: String(proof.wallet_signature ?? ''),
        chain_id: Number(proof.chain_id ?? 1),
        issued_at: issuedAtOf(message),
        expires_at: Number(proof.expires_at ?? 0),
        created_at: Date.now(),
        revoked_at:
          typeof proof.revoked_at === 'number' ? proof.revoked_at : null,
        last_used_at: null
      },
      { timer }
    );
  },

  async createDrop(input, dropId, apiRequest) {
    const timer = new Timer('relay-drop-create');
    const ctx = contextOf(input, timer);
    // Written by an earlier try that stopped before recording it.
    if (await dropsDb.findDropById(dropId)) return dropId;
    const newDrop: ApiCreateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      NewDropSchema
    );
    const invalidPart = newDrop.parts.find(
      (part) =>
        (part.content?.trim()?.length ?? 0) === 0 &&
        part.media.length === 0 &&
        (part.attachments?.length ?? 0) === 0
    );
    if (invalidPart) {
      throw new BadRequestException(
        'Each drop part must have content, media, or attachments'
      );
    }
    if (newDrop.signature_message?.trimStart().startsWith('{')) {
      throw new BadRequestException('Invalid drop signature');
    }
    const createDropRequest: ApiCreateDropRequest & {
      author: { external_id: string };
    } = {
      author: { external_id: input.profileId },
      collaborator_ids: newDrop.collaborator_ids,
      title: newDrop.title,
      parts: newDrop.parts,
      referenced_nfts: newDrop.referenced_nfts,
      mentioned_users: newDrop.mentioned_users,
      mentioned_groups: newDrop.mentioned_groups,
      mentioned_waves: newDrop.mentioned_waves,
      metadata: newDrop.metadata,
      poll: newDrop.poll,
      wave_id: newDrop.wave_id,
      reply_to: newDrop.reply_to,
      drop_type: newDrop.drop_type,
      signature: newDrop.signature,
      hide_link_preview: newDrop.hide_link_preview,
      is_additional_action_promised: newDrop.is_additional_action_promised,
      client_drop_id: newDrop.client_drop_id
    };
    const created = await deviceSignedWritesService.createDrop(
      {
        envelope: input.envelope,
        waveId: newDrop.wave_id,
        replyToDropId: newDrop.reply_to?.drop_id,
        body: apiRequest
      },
      () =>
        dropCreationService.createDrop(
          {
            createDropRequest,
            authorId: input.profileId,
            representativeId: input.profileId,
            hideLinkPreview: newDrop.hide_link_preview,
            requestDailyActivityCredit: true,
            newDropId: dropId
          },
          ctx
        ),
      ctx
    );
    try {
      await helpBotTriggerService.handleCreatedDrop(
        {
          createDropRequest,
          createdDrop: created,
          authorProfileId: input.profileId
        },
        ctx
      );
    } catch (error) {
      logger.error(
        `Help bot trigger failed for relay drop ${created.id}`,
        error
      );
    }
    return created.id;
  },

  async updateDrop(input, dropId, apiRequest) {
    const timer = new Timer('relay-drop-update');
    const ctx = contextOf(input, timer);
    const updateRequest: ApiUpdateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      UpdateDropSchema
    );
    if (updateRequest.signature_message?.trimStart().startsWith('{')) {
      throw new BadRequestException(
        'Meme Card submission signatures can only create new submissions'
      );
    }
    const waveId = await dropsDb.findWaveIdByDropId(dropId, { timer });
    if (!waveId) {
      throw new NotFoundException(`Could not find drop ${dropId}'s wave`);
    }
    if (waveId !== input.event.wave) {
      throw new BadRequestException(
        'the drop is in another wave than the event'
      );
    }
    const { drop, changed } = await deviceSignedWritesService.mutateDrop(
      {
        envelope: input.envelope,
        kind: DeviceEventKind.EDIT,
        dropId,
        waveId,
        body: apiRequest
      },
      () =>
        dropCreationService.updateDrop(
          {
            dropId,
            request: updateRequest,
            authorId: input.profileId,
            representativeId: input.profileId
          },
          ctx
        ),
      ctx
    );
    if (changed) {
      await wsListenersNotifier.notifyAboutDropUpdate(drop, ctx);
    }
  },

  async deleteDrop(input, dropId) {
    const timer = new Timer('relay-drop-delete');
    const ctx = contextOf(input, timer);
    await deviceSignedWritesService.mutateDrop(
      {
        envelope: input.envelope,
        kind: DeviceEventKind.TOMBSTONE,
        dropId,
        body: null
      },
      () => dropCreationService.deleteDropById({ id: dropId }, ctx),
      ctx
    );
  },

  async react(input, dropId, reaction) {
    const timer = new Timer('relay-drop-react');
    const ctx = contextOf(input, timer);
    await deviceSignedWritesService.mutateDrop(
      {
        envelope: input.envelope,
        kind: DeviceEventKind.REACT,
        dropId,
        body: reaction === null ? { on: false } : { on: true, reaction }
      },
      () =>
        reaction === null
          ? reactionsService.removeReaction(dropId, input.profileId, ctx)
          : reactionsService.addReaction(
              dropId,
              input.profileId,
              reaction,
              ctx
            ),
      ctx
    );
  }
};
