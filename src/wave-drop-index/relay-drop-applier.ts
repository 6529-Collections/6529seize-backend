import {
  DeviceEventKind,
  dropIdOfEvent
} from '@/api/device-signing/device-event';
import type { RelayEventTimes } from '@/api/device-signing/device-signed-writes.service';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiUpdateDropRequest } from '@/api/generated/models/ApiUpdateDropRequest';
import { BadRequestException } from '@/exceptions';
import { IngestedEvent } from './drop-index.db';

/**
 * Writes the drop events read only from the relays into 6529.io's drop
 * tables, through the same steps 6529.io's API takes for a signed write by
 * the author (validation, wave rights, moderation, the signed-event record),
 * so a drop posted to the relays alone reads on 6529.io as one posted
 * here. Events written through 6529.io are already there and are passed
 * over. Entries of decisions are the chain's and are never written here.
 *
 * Each event ends `applied`, `refused` (6529.io's rules or a signature
 * check say no: final) or stays `logged` after a failure that may pass
 * (tried again next run, up to MAX_APPLY_ATTEMPTS, then `failed`); a
 * drop's later events wait while one of its events does. An edit or a
 * reaction whose drop is not there yet waits for its post; a post whose
 * drop the index holds a delete of is never written. Only events under a
 * grant 6529.io holds or whose wallet signature it checked are written.
 *
 * 6529.io's rules count when the event is written, not when it was
 * signed: a backlog can meet a wave's slow mode, or moderation, that the
 * author never met.
 *
 * History (event_origin IMPORT: claimed before switch-on) is written with
 * no notifications or pushes; websocket updates go out as for any write.
 *
 * Only waves that moved to the 6529 chain take relay events: a wave the
 * chain holds, by the chain index's mapping. A wave that stays on 6529.io
 * (one the chain doesn't hold, and always 6529.io's records wave,
 * SIGNED_RECORDS_WAVE_ID) keeps its drops as 6529.io writes them; its relay
 * events are refused. Until the index has finished a full read, events
 * wait; a wave the index doesn't hold yet waits up to POST_WAIT_MS from
 * when the event was first seen (a wave just made on the chain), then the
 * event is refused.
 */

export const MAX_APPLY_ATTEMPTS = 5;

/** A signed write's device signature, as the API takes it. */
export interface RelayEnvelope {
  readonly grant_id: string;
  readonly seq: number;
  readonly claimed_time: number;
  readonly signature: string;
}

export interface RelayWriteInput {
  readonly event: IngestedEvent;
  /** The author's 6529.io profile. */
  readonly profileId: string;
  readonly envelope: RelayEnvelope;
  /** When it was signed and first seen, and its anchor. */
  readonly times: RelayEventTimes;
  /**
   * Whether writing it notifies, as a write through 6529.io does: only for
   * an OPERATION event. History (IMPORT) is written silently.
   */
  readonly notify: boolean;
}

/** The writes, as 6529.io's API makes them for the author. */
export interface RelayDropWrites {
  profileIdOfWallet(wallet: string): Promise<string | null>;
  /** Stores the event's grant when 6529.io doesn't hold it yet. */
  ensureGrant(grant: Record<string, unknown>): Promise<void>;
  /** Writes the post under `dropId` (its event's id as a UUID). */
  createDrop(
    input: RelayWriteInput,
    dropId: string,
    request: ApiCreateDropRequest
  ): Promise<string>;
  updateDrop(
    input: RelayWriteInput,
    dropId: string,
    request: ApiUpdateDropRequest
  ): Promise<void>;
  deleteDrop(input: RelayWriteInput, dropId: string): Promise<void>;
  react(
    input: RelayWriteInput,
    dropId: string,
    reaction: string | null
  ): Promise<void>;
}

/**
 * Whether the 6529 chain holds a wave: `moved` (the chain index maps it),
 * `stays` (the index has finished a full read and doesn't), `unknown`
 * (the index hasn't finished one).
 */
export type WaveOnChain = 'moved' | 'stays' | 'unknown';

/** What the applier needs of the index's table. */
export interface RelayApplyStore {
  /** Whether the chain holds the wave (waves-chain-mapping.ts). */
  waveOnChain(wave: string): Promise<WaveOnChain>;
  /**
   * Relay-only events to write, oldest first: those due at `now`, a share
   * per author, none behind a waiting event of the same drop.
   */
  pendingRelayEvents(limit: number, now: number): Promise<IngestedEvent[]>;
  /** Whether the index holds a checked delete of this drop by `author`. */
  hasTombstone(dropId: string, author: string): Promise<boolean>;
  /** Whether 6529.io holds an unfinished reservation of this event. */
  hasPendingReservation(eventId: string): Promise<boolean>;
  /**
   * Drops a reservation of this event an earlier try left behind (written
   * to device_signed_events, never finished), so the event can be written.
   */
  releaseStaleReservation(eventId: string): Promise<void>;
  /** 'waiting' leaves the event out of the batches until `nextTryAt`. */
  markApplied(
    ingestSeq: number,
    status: 'applied' | 'refused' | 'failed' | 'logged' | 'waiting',
    reason: string | null,
    dropId: string | null,
    nextTryAt?: number | null
  ): Promise<void>;
}

export interface ApplyReport {
  applied: number;
  refused: number;
  failed: number;
  retry: number;
  reasons: Record<string, number>;
}

/** An answer of 6529.io's rules, not a failure that may pass. */
export function isRefusal(error: unknown): boolean {
  const status = (error as { getStatusCode?: () => number })?.getStatusCode?.();
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** Not found: for an edit or a reaction, its post may come later. */
function isNotFound(error: unknown): boolean {
  return (error as { getStatusCode?: () => number })?.getStatusCode?.() === 404;
}

/** A failure that may pass: tried again next run. */
class Retry extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Waiting for something else first: tried again, not counted as a try. */
class Wait extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** How long an edit or a reaction waits for its post. */
export const POST_WAIT_MS = 60 * 60 * 1000;
/** How long a waiting event stays out of the write batches. */
export const WAIT_RETRY_MS = 5 * 60 * 1000;

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 250);
}

/** Refused by the index's own rules (an HTTP 400, as the API would). */
const Refused = BadRequestException;

function bodyOf(event: IngestedEvent): unknown {
  const body = (event.event as { body?: unknown }).body;
  return typeof body === 'string' ? JSON.parse(body) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 6529.io's records wave (SIGNED_RECORDS_WAVE_ID), or null when unset. */
export function recordsWaveIdOf(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  return env.SIGNED_RECORDS_WAVE_ID?.trim().toLowerCase() || null;
}

export const STAYS_ON_SITE_REASON =
  'the wave stays on 6529.io: the 6529 chain does not hold it';

export class RelayDropApplier {
  constructor(
    private readonly store: RelayApplyStore,
    private readonly writes: RelayDropWrites,
    private readonly now: () => number = () => Date.now(),
    private readonly recordsWaveId: string | null = recordsWaveIdOf()
  ) {}

  async applyPending({
    limit,
    deadline
  }: {
    limit: number;
    deadline: number;
  }): Promise<ApplyReport> {
    const report: ApplyReport = {
      applied: 0,
      refused: 0,
      failed: 0,
      retry: 0,
      reasons: {}
    };
    // A drop whose event must wait: its later events wait too.
    const waiting = new Set<string>();
    for (const event of await this.store.pendingRelayEvents(
      limit,
      this.now()
    )) {
      if (this.now() >= deadline) break;
      if (event.drop_id && waiting.has(event.drop_id)) continue;
      try {
        const dropId = await this.apply(event);
        await this.store.markApplied(event.ingest_seq, 'applied', null, dropId);
        report.applied++;
      } catch (thrown) {
        const error = await this.mayPass(event, thrown);
        const reason = reasonOf(error);
        report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
        if (error instanceof Wait) {
          // Not a try: the event waits for something else to happen first.
          await this.store.markApplied(
            event.ingest_seq,
            'waiting',
            reason,
            null,
            this.now() + WAIT_RETRY_MS
          );
          report.retry++;
          if (event.drop_id) waiting.add(event.drop_id);
        } else if (!(error instanceof Retry) && isRefusal(error)) {
          await this.store.markApplied(
            event.ingest_seq,
            'refused',
            reason,
            null
          );
          report.refused++;
        } else if ((event.apply_attempts ?? 0) + 1 >= MAX_APPLY_ATTEMPTS) {
          await this.store.markApplied(
            event.ingest_seq,
            'failed',
            reason,
            null
          );
          report.failed++;
        } else {
          // Tried again next run; later events of the same drop wait.
          await this.store.markApplied(
            event.ingest_seq,
            'logged',
            reason,
            null
          );
          report.retry++;
          if (event.drop_id) waiting.add(event.drop_id);
        }
      }
    }
    return report;
  }

  /**
   * A refusal that may pass on its own: an edit or a reaction whose post is
   * not there yet (for up to POST_WAIT_MS), or an event an earlier try
   * reserved and never finished (released after 15 minutes).
   */
  private async mayPass(
    event: IngestedEvent,
    thrown: unknown
  ): Promise<unknown> {
    if (
      isNotFound(thrown) &&
      event.kind !== DeviceEventKind.TOMBSTONE &&
      this.now() - event.received_at < POST_WAIT_MS
    ) {
      return new Wait(reasonOf(thrown));
    }
    if (
      /already used/.test(reasonOf(thrown)) &&
      (await this.store.hasPendingReservation(event.event_id))
    ) {
      return new Wait('an earlier try left it reserved');
    }
    return thrown;
  }

  /**
   * Refuses an event of a wave that stays on 6529.io, before anything is
   * written. The event's wave is the one written: a post's body must name
   * it, an edit's drop must be in it (relay-drop-writes.ts), and a delete's
   * or reaction's signature is checked against its drop's stored wave.
   */
  private async assertWaveMoved(event: IngestedEvent): Promise<void> {
    const wave = event.wave.trim().toLowerCase();
    if (this.recordsWaveId !== null && wave === this.recordsWaveId) {
      throw new Refused(
        "the wave stays on 6529.io: it is 6529.io's records wave"
      );
    }
    const onChain = await this.store.waveOnChain(wave);
    if (onChain === 'moved') return;
    if (onChain === 'unknown') {
      throw new Wait('the chain index has not finished reading the chain');
    }
    if (this.now() - event.received_at < POST_WAIT_MS) {
      throw new Wait('the chain index does not hold the wave yet');
    }
    throw new Refused(STAYS_ON_SITE_REASON);
  }

  /** Writes one event; returns the drop it wrote or touched. */
  private async apply(event: IngestedEvent): Promise<string | null> {
    await this.assertWaveMoved(event);
    if (event.grant_check !== 'known' && event.grant_check !== 'signature') {
      // A contract wallet's grant 6529.io never verified.
      throw new Refused("the event's grant could not be verified here");
    }
    const profileId = await this.writes.profileIdOfWallet(event.author);
    if (!profileId) {
      throw new Refused('the author has no 6529.io profile');
    }
    await this.writes.ensureGrant(event.grant_proof);
    await this.store.releaseStaleReservation(event.event_id);
    const signed = event.event as Record<string, unknown>;
    const input: RelayWriteInput = {
      event,
      profileId,
      envelope: {
        grant_id: event.auth_ref.toLowerCase(),
        seq: event.seq,
        claimed_time: event.claimed_time,
        signature: String(signed.signature).toLowerCase()
      },
      times: {
        signedAt: event.claimed_time,
        seenAt: event.received_at,
        anchor: Number(signed.anchor ?? 0)
      },
      notify: event.event_origin === 'OPERATION'
    };
    const body = bodyOf(event);
    const target = Array.isArray(signed.refs)
      ? String(signed.refs[0] ?? '')
      : '';
    switch (event.kind) {
      case DeviceEventKind.POST: {
        if (!isRecord(body)) throw new Refused('a post without a body');
        const request = body as unknown as ApiCreateDropRequest;
        if (request.wave_id !== event.wave) {
          throw new Refused('the body names another wave than the event');
        }
        if ((request.drop_type ?? ApiDropType.Chat) !== ApiDropType.Chat) {
          throw new Refused(
            "only chat drops are written from the relays; entries are the chain's"
          );
        }
        const dropId = event.drop_id ?? dropIdOfEvent(event.event_id);
        if (await this.store.hasTombstone(dropId, event.author)) {
          throw new Refused('the drop was deleted before it was written');
        }
        return this.writes.createDrop(input, dropId, request);
      }
      case DeviceEventKind.EDIT: {
        if (!target) throw new Refused('an edit names no drop');
        if (!isRecord(body)) throw new Refused('an edit without a body');
        await this.writes.updateDrop(
          input,
          target,
          body as unknown as ApiUpdateDropRequest
        );
        return target;
      }
      case DeviceEventKind.TOMBSTONE:
        if (!target) throw new Refused('a delete names no drop');
        await this.writes.deleteDrop(input, target);
        return target;
      case DeviceEventKind.REACT: {
        if (!target) throw new Refused('a reaction names no drop');
        if (!isRecord(body) || typeof body.on !== 'boolean') {
          throw new Refused('a reaction without its on flag');
        }
        const reaction = body.on ? body.reaction : null;
        if (body.on && typeof reaction !== 'string') {
          throw new Refused('a reaction without its reaction');
        }
        await this.writes.react(input, target, reaction as string | null);
        return target;
      }
      default:
        throw new Refused(`unknown kind ${event.kind}`);
    }
  }
}
