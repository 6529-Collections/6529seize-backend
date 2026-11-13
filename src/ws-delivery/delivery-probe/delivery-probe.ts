import { randomUUID } from 'node:crypto';
import {
  ProbePost,
  ProbeReceipt,
  ProbeSummary,
  summarizeProbe
} from './delivery-probe-stats';

/**
 * Two-client delivery probe (WAVES-PLAN 1.0, Appendix A.4).
 *
 * One process plays both browsers, so every client-side time comes from one
 * clock: the poster's POST start, its response, and each listener's frame
 * receipt. Server segments come from the frame's `server_received_at` and
 * `sent_at` (server clock). It posts plain chat drops to a dedicated wave.
 */

export type ListenerMode = 'app' | 'open-wave';

export interface DeliveryProbeOptions {
  readonly apiBase: string;
  readonly wsUrl: string;
  readonly waveId: string;
  readonly count: number;
  readonly intervalMs: number;
  readonly posterJwt: string;
  readonly listenerJwt: string | null;
  readonly listenerMode: ListenerMode;
  readonly listeners: number;
  readonly settleMs: number;
  readonly connectTimeoutMs: number;
  readonly stagingAuth?: string;
  readonly runId?: string;
}

/** The subset of a WebSocket the probe uses (`ws` and browsers both fit). */
export interface ProbeSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
}

export interface DeliveryProbeDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly createSocket: (url: string) => ProbeSocket;
  readonly fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ) => Promise<{ status: number; json(): Promise<unknown> }>;
}

export interface DeliveryProbeResult {
  readonly runId: string;
  readonly posts: ProbePost[];
  readonly receipts: ProbeReceipt[];
  readonly summary: ProbeSummary;
}

export const PROBE_CONTENT_PREFIX = 'delivery probe';

export function probeContent(runId: string, index: number): string {
  return `${PROBE_CONTENT_PREFIX} ${runId} #${index}`;
}

function parseProbeIndex(content: unknown, runId: string): number | null {
  if (typeof content !== 'string') return null;
  const prefix = `${PROBE_CONTENT_PREFIX} ${runId} #`;
  if (!content.startsWith(prefix)) return null;
  const index = Number(content.slice(prefix.length));
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Maps a drop frame to the probe post it carries, or null. */
export function probeIndexOfFrame(
  frame: unknown,
  runId: string,
  dropIndexes: ReadonlyMap<string, number>
): number | null {
  if (!frame || typeof frame !== 'object') return null;
  const type = Reflect.get(frame, 'type');
  const data = Reflect.get(frame, 'data');
  if (!data || typeof data !== 'object') return null;
  if (type === 'DROP_UPDATE') {
    const parts = Reflect.get(data, 'parts');
    const fromContent = Array.isArray(parts)
      ? parseProbeIndex(parts[0]?.content, runId)
      : null;
    if (fromContent !== null) return fromContent;
    const id = Reflect.get(data, 'id');
    return typeof id === 'string' ? (dropIndexes.get(id) ?? null) : null;
  }
  if (type === 'DROP_UPDATE_REF') {
    const id = Reflect.get(data, 'drop_id');
    const updateType = Reflect.get(data, 'update_type');
    return updateType === 'DROP_UPDATE' && typeof id === 'string'
      ? (dropIndexes.get(id) ?? null)
      : null;
  }
  return null;
}

function withQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params))
    parsed.searchParams.set(key, value);
  return parsed.toString();
}

function openListener(
  options: DeliveryProbeOptions,
  deps: DeliveryProbeDeps,
  onFrame: (frame: unknown, receivedAt: number) => void
): Promise<ProbeSocket> {
  return new Promise((resolve, reject) => {
    const socket = deps.createSocket(
      withQuery(options.wsUrl, { recovery_capability: 'resync_v1' })
    );
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error('listener did not become ready in time'));
    }, options.connectTimeoutMs);
    const ready = () => {
      if (settled) return;
      if (options.listenerMode === 'open-wave') {
        socket.send(
          JSON.stringify({ type: 'SUBSCRIBE_TO_WAVE', wave_id: options.waveId })
        );
      }
      settled = true;
      clearTimeout(timeout);
      resolve(socket);
    };
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(error);
    }
    socket.onopen = () => {
      if (options.listenerJwt) {
        socket.send(
          JSON.stringify({
            type: 'AUTHENTICATE',
            access_token: options.listenerJwt
          })
        );
      } else {
        ready();
      }
    };
    socket.onmessage = (event) => {
      const receivedAt = deps.now();
      if (typeof event.data !== 'string') return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const type =
        frame && typeof frame === 'object'
          ? Reflect.get(frame, 'type')
          : undefined;
      if (type === 'AUTHENTICATED') ready();
      else if (type === 'AUTHENTICATION_FAILED')
        fail(new Error('listener authentication failed'));
      else onFrame(frame, receivedAt);
    };
    socket.onerror = () => fail(new Error('listener socket error'));
    socket.onclose = () => fail(new Error('listener socket closed'));
  });
}

export async function runDeliveryProbe(
  options: DeliveryProbeOptions,
  deps: DeliveryProbeDeps
): Promise<DeliveryProbeResult> {
  const runId = options.runId ?? randomUUID().slice(0, 8);
  const posts: ProbePost[] = [];
  const receipts: ProbeReceipt[] = [];
  const dropIndexes = new Map<string, number>();
  const sockets: ProbeSocket[] = [];
  try {
    for (let listener = 0; listener < options.listeners; listener++) {
      sockets.push(
        await openListener(options, deps, (frame, receivedAt) => {
          const index = probeIndexOfFrame(frame, runId, dropIndexes);
          if (index === null) return;
          receipts.push({
            index,
            listener,
            receivedAt,
            serverReceivedAt: finiteOrNull(
              Reflect.get(frame as object, 'server_received_at')
            ),
            sentAt: finiteOrNull(Reflect.get(frame as object, 'sent_at'))
          });
        })
      );
    }
    // SUBSCRIBE_TO_WAVE has no acknowledgement; let the row update land.
    if (options.listenerMode === 'open-wave') await deps.sleep(500);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${options.posterJwt}`,
      ...(options.stagingAuth ? { 'x-6529-auth': options.stagingAuth } : {})
    };
    for (let index = 0; index < options.count; index++) {
      const postedAt = deps.now();
      let respondedAt: number | null = null;
      let dropId: string | null = null;
      let status: number | null = null;
      try {
        const response = await deps.fetch(`${options.apiBase}/api/drops`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            wave_id: options.waveId,
            drop_type: 'CHAT',
            title: null,
            parts: [
              {
                content: probeContent(runId, index),
                quoted_drop: null,
                media: []
              }
            ],
            referenced_nfts: [],
            mentioned_users: [],
            mentioned_waves: [],
            metadata: [],
            signature: null
          })
        });
        status = response.status;
        const body = await response.json().catch(() => null);
        const id =
          body && typeof body === 'object' ? Reflect.get(body, 'id') : null;
        if (response.status < 300 && typeof id === 'string') {
          respondedAt = deps.now();
          dropId = id;
          dropIndexes.set(id, index);
        }
      } catch {
        /* recorded as a failed post */
      }
      posts.push({ index, postedAt, respondedAt, dropId, status });
      if (index < options.count - 1) await deps.sleep(options.intervalMs);
    }
    await deps.sleep(options.settleMs);
  } finally {
    for (const socket of sockets) {
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }
  return {
    runId,
    posts,
    receipts,
    summary: summarizeProbe({ posts, receipts, listeners: options.listeners })
  };
}
