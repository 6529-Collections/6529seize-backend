import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropSignedEvents } from '@/api/generated/models/ApiDropSignedEvents';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { RequestContext } from '@/request.context';
import { DeviceSigningDb, deviceSigningDb } from './device-signing.db';
import {
  toApiDeviceGrantProof,
  toApiDeviceSignedEvent
} from './device-signing.mappers';

/**
 * Signed events carry the signed bodies (the drop's content) and their grants
 * name the author's wallet. The drop read path hides the content when
 * moderation hides it from the caller and replaces the author when the author
 * is anonymous to the caller, so neither may be revealed here either. A drop
 * without a moderation verdict is treated as hidden.
 */
function hidesSignedEvents(
  drop: Pick<ApiDrop, 'moderation' | 'author'>
): boolean {
  return (
    drop.moderation?.can_view !== true || drop.author?.is_anonymous === true
  );
}

export class DropSignedEventsService {
  constructor(
    private readonly db: DeviceSigningDb,
    private readonly drops: Pick<DropsApiService, 'findDropByIdOrThrow'>
  ) {}

  /**
   * 404s exactly like GET /drops/{dropId} when the caller cannot read it.
   * When the read path hides the drop's content or author from the caller,
   * returns the same empty result as for an unsigned drop.
   */
  async findForDrop(
    dropId: string,
    ctx: RequestContext
  ): Promise<ApiDropSignedEvents> {
    const drop = await this.drops.findDropByIdOrThrow({ dropId }, ctx);
    if (hidesSignedEvents(drop)) {
      return {
        drop_id: dropId,
        current_event_id: null,
        events: [],
        grants: []
      };
    }
    const [events, currentEventId] = await Promise.all([
      this.db.findEventsByDropId(dropId, ctx),
      this.db.findDropAuthorSignatureEventId(dropId, ctx)
    ]);
    const grantIds = Array.from(new Set(events.map((it) => it.grant_id)));
    const grants = await this.db.findGrantsByIds(grantIds, ctx);
    return {
      drop_id: dropId,
      current_event_id: currentEventId,
      events: events.map(toApiDeviceSignedEvent),
      grants: grants.map(toApiDeviceGrantProof)
    };
  }
}

export const dropSignedEventsService = new DropSignedEventsService(
  deviceSigningDb,
  dropsService
);
