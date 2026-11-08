/**
 * Liveness check a client can send on any socket (app or typing), with or
 * without authentication:
 *
 *   client → `{"type":"PING","id":"<1-32 of A-Z a-z 0-9 _ . : ->"}`
 *   server → `{"type":"PONG","id":"<same id>"}` on the same connection
 *
 * The server answers before authentication and without database work, so a
 * client can tell a healthy socket from a dead one without reconnecting.
 * A frame larger than {@link WS_PING_MAX_FRAME_BYTES} is not treated as a
 * PING; a PING with any other field or an invalid id gets no PONG.
 */
export const WS_PING_TYPE = 'PING';
export const WS_PONG_TYPE = 'PONG';
export const WS_PING_MAX_FRAME_BYTES = 128;
const PING_ID = /^[A-Za-z0-9_.:-]{1,32}$/;

export type WsPingFrame =
  | { readonly kind: 'ping'; readonly id: string }
  | { readonly kind: 'invalid' };

/** The PING carried by `body`, or null when it is not a PING frame. */
export function readPingFrame(
  body: string | null | undefined
): WsPingFrame | null {
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body, 'utf8') > WS_PING_MAX_FRAME_BYTES ||
    !body.includes(WS_PING_TYPE)
  ) {
    return null;
  }
  let frame: unknown;
  try {
    frame = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    !frame ||
    typeof frame !== 'object' ||
    Array.isArray(frame) ||
    (frame as { type?: unknown }).type !== WS_PING_TYPE
  ) {
    return null;
  }
  const { id, ...rest } = frame as { type: string; id?: unknown };
  const extraKeys = Object.keys(rest).filter((key) => key !== 'type');
  if (typeof id !== 'string' || !PING_ID.test(id) || extraKeys.length) {
    return { kind: 'invalid' };
  }
  return { kind: 'ping', id };
}

export function pongFrame(id: string): string {
  return JSON.stringify({ type: WS_PONG_TYPE, id });
}
