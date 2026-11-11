import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropSignedEvents } from '@/api/generated/models/ApiDropSignedEvents';
import { ApiDropSignedEventsBatch } from '@/api/generated/models/ApiDropSignedEventsBatch';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import {
  competitionAnonymityService,
  CompetitionAnonymityService
} from '@/competitions/competition-anonymity';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
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

function groupEventsByDrop(
  events: readonly DeviceSignedEventEntity[]
): Map<string, DeviceSignedEventEntity[]> {
  const byDrop = new Map<string, DeviceSignedEventEntity[]>();
  for (const event of events) {
    const dropId = event.drop_id;
    if (dropId === null) {
      continue;
    }
    const dropEvents = byDrop.get(dropId) ?? [];
    dropEvents.push(event);
    byDrop.set(dropId, dropEvents);
  }
  return byDrop;
}

/** Largest number of drops in one batch read. */
export const DROP_SIGNED_EVENTS_BATCH_MAX_DROPS = 50;
/** Largest number of events returned per drop by a batch read. */
export const DROP_SIGNED_EVENTS_BATCH_EVENTS_PER_DROP = 20;

export class DropSignedEventsService {
  constructor(
    private readonly db: DeviceSigningDb,
    private readonly drops: Pick<
      DropsApiService,
      'findDropByIdOrThrow' | 'findReadableDropsByIds'
    >,
    private readonly anonymity: Pick<
      CompetitionAnonymityService,
      'hiddenDropIds'
    > = competitionAnonymityService
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
    if (
      hidesSignedEvents(drop) ||
      (await this.isAnonymousToCaller(dropId, ctx))
    ) {
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

  /**
   * The batch form of findForDrop, for drops listed in `dropIds` (distinct).
   * Each drop the caller can read gets the result findForDrop would give,
   * with these differences: only content events (post, edit, delete), at
   * most DROP_SIGNED_EVENTS_BATCH_EVENTS_PER_DROP of them (the first, the
   * current one and the newest; `truncated_drop_ids` names drops with more),
   * and grants listed once for the whole batch. Ids the caller cannot read,
   * whether they exist or not, are listed in `unavailable`.
   */
  async findForDrops(
    dropIds: readonly string[],
    ctx: RequestContext
  ): Promise<ApiDropSignedEventsBatch> {
    const readable = await this.drops.findReadableDropsByIds([...dropIds], ctx);
    const readableIds = new Set(readable.map((drop) => drop.id));
    const shown = readable
      .filter((drop) => !hidesSignedEvents(drop))
      .map((drop) => drop.id);
    const anonymous = shown.length
      ? await this.anonymity.hiddenDropIds(shown, ctx)
      : new Set<string>();
    const signedIds = shown.filter((dropId) => !anonymous.has(dropId));
    const signed = new Set(signedIds);
    const [loaded, currentEventIds] = await Promise.all([
      this.db.findContentEventsByDropIds(
        signedIds,
        DROP_SIGNED_EVENTS_BATCH_EVENTS_PER_DROP - 2,
        ctx
      ),
      this.db.findDropAuthorSignatureEventIds(signedIds, ctx)
    ]);
    // Only drops the caller may see signed events of contribute anything.
    const events = loaded.events.filter(
      (event) => event.drop_id !== null && signed.has(event.drop_id)
    );
    const grants = await this.db.findGrantsByIds(
      Array.from(new Set(events.map((it) => it.grant_id))),
      ctx
    );
    const eventsByDrop = groupEventsByDrop(events);
    return {
      // Drops whose content or author is hidden from the caller were never
      // read for events, so they get the empty result of an unsigned drop.
      drops: dropIds
        .filter((dropId) => readableIds.has(dropId))
        .map((dropId) => ({
          drop_id: dropId,
          current_event_id: signed.has(dropId)
            ? (currentEventIds.get(dropId) ?? null)
            : null,
          events: (eventsByDrop.get(dropId) ?? []).map(toApiDeviceSignedEvent),
          grants: []
        })),
      grants: grants.map(toApiDeviceGrantProof),
      unavailable: dropIds.filter((dropId) => !readableIds.has(dropId)),
      truncated_drop_ids: dropIds.filter(
        (dropId) => signed.has(dropId) && loaded.truncatedDropIds.has(dropId)
      )
    };
  }

  /**
   * The read path's own anonymity rule, asked directly so that hiding the
   * author's wallet never depends on how the mapped author is represented.
   */
  private async isAnonymousToCaller(
    dropId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const hidden = await this.anonymity.hiddenDropIds([dropId], ctx);
    return hidden.has(dropId);
  }
}

export const dropSignedEventsService = new DropSignedEventsService(
  deviceSigningDb,
  dropsService,
  competitionAnonymityService
);
