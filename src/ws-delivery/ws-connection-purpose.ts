import { WsConnectionPurpose } from '@/entities/IWSConnection';

/**
 * SQL predicate every broadcast recipient query must include: typing-purpose
 * sockets (`?purpose=typing`) receive only USER_IS_TYPING, so they are left
 * out of every other frame. A null purpose is a legacy socket and stays in.
 *
 * `ws-broadcast-recipients-guard.test.ts` fails when a query that selects
 * recipients from `ws_connections` does not use it.
 */
export function broadcastPurposeFilterSql(alias = 'ws'): string {
  return `(${alias}.purpose is null or ${alias}.purpose <> '${WsConnectionPurpose.TYPING}')`;
}
