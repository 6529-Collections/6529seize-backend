import { ApiDropSignedEvents } from '@/api/generated/models/ApiDropSignedEvents';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { RequestContext } from '@/request.context';
import { DeviceSigningDb, deviceSigningDb } from './device-signing.db';
import {
  toApiDeviceGrantProof,
  toApiDeviceSignedEvent
} from './device-signing.mappers';

export class DropSignedEventsService {
  constructor(
    private readonly db: DeviceSigningDb,
    private readonly drops: Pick<DropsApiService, 'findDropByIdOrThrow'>
  ) {}

  /** 404s exactly like GET /drops/{dropId} when the caller cannot read it. */
  async findForDrop(
    dropId: string,
    ctx: RequestContext
  ): Promise<ApiDropSignedEvents> {
    await this.drops.findDropByIdOrThrow({ dropId }, ctx);
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
