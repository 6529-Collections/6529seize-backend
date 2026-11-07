import type { ApiDrop } from '@/api/generated/models/ApiDrop';
import type { DropUpdateRefType } from '@/api/ws/ws-message';

/**
 * Work handed from the API to the wave fan-out worker (waves 1.1).
 *
 * Jobs carry everything the worker needs to send without re-reading the
 * drop: the audience-neutral drop (quotes already restricted to the wave
 * audience), the competition-anonymity inputs, and the recipients with the
 * JWT expiry their audience query returned. Recipient-specific payload parts
 * (viewer context, credit left) are resolved by the worker per chunk.
 */
export const WAVE_FANOUT_JOB_VERSION = 1;

export interface QueuedRecipient {
  /** Connection id. */
  readonly c: string;
  /** Profile id, or null for an anonymous socket. */
  readonly p: string | null;
  /** Stored JWT expiry (epoch seconds) for the send fence. */
  readonly e: number;
}

export interface DropFramesJob {
  readonly v: typeof WAVE_FANOUT_JOB_VERSION;
  readonly kind: 'drop_frames';
  readonly update_type: DropUpdateRefType;
  readonly reason?: string;
  /** Gap marker of a new drop's DROP_UPDATE (waves 1.5); absent otherwise. */
  readonly prev_serial_no?: number | null;
  readonly server_received_at: number | null;
  readonly enqueued_at: number;
  /** 0-based position of this chunk, so open-wave viewers go out first. */
  readonly chunk: number;
  readonly drop: ApiDrop;
  readonly hidden_drop_ids: string[];
  readonly author_ids_by_drop_id: [string, string][];
  readonly recipients: QueuedRecipient[];
}

export interface DropCreatedEffectsJob {
  readonly v: typeof WAVE_FANOUT_JOB_VERSION;
  readonly kind: 'drop_created_effects';
  readonly enqueued_at: number;
  readonly drop_id: string;
  readonly wave_id: string;
  readonly author_id: string;
  readonly pending_push_notification_ids: number[];
  readonly dm_unread_recipient_ids: string[];
  readonly collaborator_ids: string[];
}

export type WaveFanoutJob = DropFramesJob | DropCreatedEffectsJob;

/** SQS accepts 256 KiB per message; keep headroom for attributes. */
export const WAVE_FANOUT_MAX_MESSAGE_BYTES = 240 * 1024;

/**
 * Splits recipients into jobs of at most `chunkSize`. A chunk whose body is
 * still too large for SQS is halved until it fits; a drop that cannot fit even
 * with one recipient is returned in `unqueueable` for inline delivery.
 */
export function buildDropFramesJobs(
  base: Omit<DropFramesJob, 'v' | 'kind' | 'chunk' | 'recipients'>,
  recipients: readonly QueuedRecipient[],
  chunkSize: number
): { jobs: DropFramesJob[]; unqueueable: QueuedRecipient[] } {
  const jobs: DropFramesJob[] = [];
  const unqueueable: QueuedRecipient[] = [];
  if (!recipients.length) return { jobs, unqueueable };
  // The drop is repeated in every job: if it does not fit with a single
  // recipient, no split can help, so skip the halving entirely.
  const smallest: DropFramesJob = {
    v: WAVE_FANOUT_JOB_VERSION,
    kind: 'drop_frames',
    ...base,
    chunk: 0,
    recipients: [recipients[0]]
  };
  if (jobByteLength(smallest) > WAVE_FANOUT_MAX_MESSAGE_BYTES) {
    return { jobs, unqueueable: [...recipients] };
  }
  const pending: QueuedRecipient[][] = [];
  for (let offset = 0; offset < recipients.length; offset += chunkSize) {
    pending.push(recipients.slice(offset, offset + chunkSize));
  }
  while (pending.length) {
    const slice = pending.shift()!;
    const job: DropFramesJob = {
      v: WAVE_FANOUT_JOB_VERSION,
      kind: 'drop_frames',
      ...base,
      chunk: jobs.length,
      recipients: slice
    };
    if (jobByteLength(job) <= WAVE_FANOUT_MAX_MESSAGE_BYTES) {
      jobs.push(job);
    } else if (slice.length > 1) {
      const half = Math.ceil(slice.length / 2);
      pending.unshift(slice.slice(0, half), slice.slice(half));
    } else {
      unqueueable.push(...slice);
    }
  }
  return { jobs, unqueueable };
}

export function jobByteLength(job: WaveFanoutJob): number {
  return Buffer.byteLength(JSON.stringify(job), 'utf8');
}

/** The kind of a queued body without one: today's drop fan-out chunk. */
export const DEFAULT_WAVE_JOB_KIND = 'drop_frames';

/** Reads a queued body's kind; the body itself is validated by its handler. */
export function parseWaveJobEnvelope(body: string): {
  kind: string;
  job: Record<string, unknown>;
} {
  const job: unknown = JSON.parse(body);
  if (!job || typeof job !== 'object' || Array.isArray(job))
    throw new Error('Wave job body is not an object');
  const kind = Reflect.get(job, 'kind');
  return {
    kind: typeof kind === 'string' && kind ? kind : DEFAULT_WAVE_JOB_KIND,
    job: job as Record<string, unknown>
  };
}

function requireVersion(job: Record<string, unknown>): void {
  if (job.v !== WAVE_FANOUT_JOB_VERSION)
    throw new Error('Unsupported wave fan-out job version');
}

export function asDropFramesJob(job: Record<string, unknown>): DropFramesJob {
  requireVersion(job);
  const frames = job as Partial<DropFramesJob>;
  if (
    !frames.drop ||
    typeof frames.drop.id !== 'string' ||
    !Array.isArray(frames.recipients) ||
    !Array.isArray(frames.hidden_drop_ids) ||
    !Array.isArray(frames.author_ids_by_drop_id) ||
    !(
      frames.prev_serial_no === undefined ||
      frames.prev_serial_no === null ||
      Number.isSafeInteger(frames.prev_serial_no)
    )
  )
    throw new Error('Malformed drop_frames job');
  return { ...frames, kind: 'drop_frames' } as DropFramesJob;
}

export function asDropCreatedEffectsJob(
  job: Record<string, unknown>
): DropCreatedEffectsJob {
  requireVersion(job);
  const effects = job as Partial<DropCreatedEffectsJob>;
  if (
    typeof effects.drop_id !== 'string' ||
    typeof effects.wave_id !== 'string' ||
    !Array.isArray(effects.pending_push_notification_ids) ||
    !Array.isArray(effects.dm_unread_recipient_ids)
  )
    throw new Error('Malformed drop_created_effects job');
  return {
    ...effects,
    collaborator_ids: Array.isArray(effects.collaborator_ids)
      ? effects.collaborator_ids
      : []
  } as DropCreatedEffectsJob;
}
