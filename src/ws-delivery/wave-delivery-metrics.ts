/**
 * Per-hop timings for the chat delivery path (WAVES-PLAN Appendix A.5).
 *
 * Every record is one CloudWatch Embedded Metric Format line on stdout: no API
 * call, no IAM change. Dimensions stay low-cardinality (environment and frame
 * type). Drop and wave ids are plain log properties for Logs Insights only.
 */

export const WAVE_DELIVERY_NAMESPACE = '6529/WaveDelivery';
/** EMF accepts at most 100 values for one metric in one record. */
export const EMF_MAX_VALUES = 100;

type EmfUnit = 'Milliseconds' | 'Count';

interface EmfRecord {
  readonly dimensions: Record<string, string>;
  readonly metrics: Record<string, { unit: EmfUnit; value: number | number[] }>;
  readonly properties?: Record<string, string | number | boolean | null>;
}

function deliveryEnvironment(): string {
  return (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
}

function metricsEnabled(): boolean {
  return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

function writeEmf(record: EmfRecord): void {
  if (!metricsEnabled()) return;
  const dimensions = {
    Environment: deliveryEnvironment(),
    ...record.dimensions
  };
  const metricValues: Record<string, number | number[]> = {};
  const definitions: { Name: string; Unit: EmfUnit }[] = [];
  for (const [name, { unit, value }] of Object.entries(record.metrics)) {
    if (Array.isArray(value) ? !value.length : !Number.isFinite(value)) {
      continue;
    }
    definitions.push({ Name: name, Unit: unit });
    metricValues[name] = value;
  }
  if (!definitions.length) return;
  // Telemetry must never alter delivery.
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: WAVE_DELIVERY_NAMESPACE,
              Dimensions: [Object.keys(dimensions)],
              Metrics: definitions
            }
          ]
        },
        ...dimensions,
        ...(record.properties ?? {}),
        ...metricValues
      })}\n`
    );
  } catch {
    /* ignore */
  }
}

/**
 * Keeps an evenly spaced sample in insertion order. Send completion order is
 * unrelated to the duration ranking, so the sample stays representative for
 * CloudWatch percentiles.
 */
export function sampleValues(values: readonly number[], max: number): number[] {
  if (values.length <= max) return [...values];
  const step = values.length / max;
  return Array.from(
    { length: max },
    (_, index) => values[Math.floor(index * step)]
  );
}

/** Where a fan-out ran: inside the request, or in the 1.1 worker. */
export type FanoutStage = 'inline' | 'async';

export type FanoutSendOutcome =
  | 'sent'
  | 'resync_pending'
  | 'gone'
  | 'failed'
  | 'error';

/**
 * Measures one fan-out of one frame type. Times are wall-clock milliseconds;
 * `serverReceivedAt` is when the API received the triggering request, so
 * `fanout_server_last_send_ms` is the full server-side delivery time.
 */
export class FanoutMeasurement {
  private readonly startedAt: number;
  private queryMs: number | null = null;
  private prepareMs: number | null = null;
  private recipients = 0;
  private serializations = 0;
  private connectionReads = 0;
  private handedOffRecipients = 0;
  private handOffMs: number | null = null;
  private fellBackRecipients = 0;
  private firstSettledAt: number | null = null;
  private lastSettledAt: number | null = null;
  private readonly sendDurations: number[] = [];
  private readonly outcomes: Record<FanoutSendOutcome, number> = {
    sent: 0,
    resync_pending: 0,
    gone: 0,
    failed: 0,
    error: 0
  };

  constructor(
    private readonly frameType: string,
    private readonly serverReceivedAt: number | null,
    private readonly now: () => number = Date.now,
    private readonly stage: FanoutStage = 'inline'
  ) {
    this.startedAt = now();
  }

  queryDone(recipients: number): void {
    this.queryMs = this.now() - this.startedAt;
    this.recipients = recipients;
  }

  /** Records the first preparation only; later batches reuse its timing. */
  prepareDone(): void {
    this.prepareMs ??= this.now() - this.startedAt - (this.queryMs ?? 0);
  }

  /** Recipients accepted by the queue for the worker, and the hand-off time. */
  handedOff(recipients: number, milliseconds: number): void {
    this.handedOffRecipients += recipients;
    this.handOffMs = milliseconds;
  }

  /** Recipients the queue did not accept, sent inline instead. */
  fellBack(recipients: number): void {
    this.fellBackRecipients += recipients;
  }

  serialized(): void {
    this.serializations++;
  }

  connectionRead(): void {
    this.connectionReads++;
  }

  sendSettled(startedAt: number, outcome: FanoutSendOutcome): void {
    const settledAt = this.now();
    this.sendDurations.push(settledAt - startedAt);
    this.outcomes[outcome]++;
    this.firstSettledAt ??= settledAt;
    this.lastSettledAt = settledAt;
  }

  emit(properties: Record<string, string | number | null> = {}): void {
    const finishedAt = this.now();
    const sinceStart = (at: number | null) =>
      at === null ? Number.NaN : at - this.startedAt;
    writeEmf({
      dimensions: { FrameType: this.frameType, Stage: this.stage },
      metrics: {
        fanout_recipients: { unit: 'Count', value: this.recipients },
        fanout_query_ms: { unit: 'Milliseconds', value: this.queryMs ?? NaN },
        fanout_prepare_ms: {
          unit: 'Milliseconds',
          value: this.prepareMs ?? NaN
        },
        fanout_first_send_ms: {
          unit: 'Milliseconds',
          value: sinceStart(this.firstSettledAt)
        },
        fanout_last_send_ms: {
          unit: 'Milliseconds',
          value: sinceStart(this.lastSettledAt)
        },
        fanout_total_ms: {
          unit: 'Milliseconds',
          value: finishedAt - this.startedAt
        },
        fanout_server_last_send_ms: {
          unit: 'Milliseconds',
          value:
            this.serverReceivedAt === null || this.lastSettledAt === null
              ? NaN
              : this.lastSettledAt - this.serverReceivedAt
        },
        fanout_per_send_ms: {
          unit: 'Milliseconds',
          value: sampleValues(this.sendDurations, EMF_MAX_VALUES)
        },
        fanout_serializations: { unit: 'Count', value: this.serializations },
        fanout_connection_reads: {
          unit: 'Count',
          value: this.connectionReads
        },
        fanout_handed_off: {
          unit: 'Count',
          value: this.handedOffRecipients
        },
        fanout_hand_off_ms: {
          unit: 'Milliseconds',
          value: this.handOffMs ?? Number.NaN
        },
        fanout_fell_back: { unit: 'Count', value: this.fellBackRecipients },
        fanout_sent: { unit: 'Count', value: this.outcomes.sent },
        fanout_resync_pending: {
          unit: 'Count',
          value: this.outcomes.resync_pending
        },
        fanout_gone: { unit: 'Count', value: this.outcomes.gone },
        fanout_failed: {
          unit: 'Count',
          value: this.outcomes.failed + this.outcomes.error
        }
      },
      properties: { event: 'WAVE_FANOUT', ...properties }
    });
  }
}

/** One queued wave job's outcome, by job kind (waves 1.1 worker). */
export function emitWaveJobMetrics(
  kind: string,
  outcome: 'processed' | 'failed',
  queueAgeMs: number | null
): void {
  writeEmf({
    dimensions: { JobKind: kind },
    metrics: {
      wave_job_processed: {
        unit: 'Count',
        value: outcome === 'processed' ? 1 : 0
      },
      wave_job_failed: { unit: 'Count', value: outcome === 'failed' ? 1 : 0 },
      wave_job_queue_age_ms: {
        unit: 'Milliseconds',
        value: queueAgeMs ?? Number.NaN
      }
    },
    properties: { event: 'WAVE_JOB' }
  });
}

/** Server-side hops of one drop POST, emitted as one EMF record. */
export class DropPostHops {
  private readonly hops: Record<string, number> = {};
  private readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  elapsed(): number {
    return this.now() - this.startedAt;
  }

  async time<T>(name: string, action: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await action();
    } finally {
      this.hops[name] = this.now() - startedAt;
    }
  }

  set(name: string, milliseconds: number | null): void {
    if (milliseconds !== null && Number.isFinite(milliseconds)) {
      this.hops[name] = milliseconds;
    }
  }

  snapshot(): Readonly<Record<string, number>> {
    return { ...this.hops };
  }

  emit(properties: Record<string, string | number | null> = {}): void {
    writeEmf({
      dimensions: { FrameType: 'DROP_POST' },
      metrics: Object.fromEntries(
        Object.entries(this.hops).map(([name, value]) => [
          name,
          { unit: 'Milliseconds' as const, value }
        ])
      ),
      properties: { event: 'WAVE_DROP_POST', ...properties }
    });
  }
}

/**
 * Milliseconds since the API received the request behind `timer`, or null for
 * background producers that have no request timer.
 */
export function serverReceivedAtFromTimer(
  timer: { getTotalTimePassed(): { toMillis(): number } } | undefined,
  now: number = Date.now()
): number | null {
  if (!timer) return null;
  try {
    const elapsed = timer.getTotalTimePassed().toMillis();
    return Number.isFinite(elapsed) ? now - elapsed : null;
  } catch {
    return null;
  }
}
