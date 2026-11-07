import { WS_CONNECTIONS_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { broadcastPurposeFilterSql } from '@/ws-delivery/ws-connection-purpose';

/**
 * Which frontend builds hold live sockets. A client may declare its build on
 * `$connect` as `?client_version=<git sha>`; old tabs keep running pre-fix
 * code for many hours, so the share per build shows how far a fix has
 * reached. Only the build is recorded: never who is connected.
 */

const CLIENT_VERSION_PATTERN = /^[0-9a-f]{7,40}$/;

/** Builds reported by name; the rest are summed as `other`. */
export const CLIENT_VERSION_TOP_N = 20;
export const CLIENT_VERSION_OTHER = 'other';
/** Sockets from clients that declared no (valid) build. */
export const CLIENT_VERSION_NONE = 'none';

/**
 * The declared build, if it is a short or full hex git SHA (7–40 chars).
 * Anything else is ignored, so it never reaches storage or a metric.
 */
export function clientVersionFromQuery(
  query: Record<string, string | undefined> | null | undefined
): string | null {
  const value = query?.client_version;
  if (typeof value !== 'string') return null;
  const version = value.trim().toLowerCase();
  return CLIENT_VERSION_PATTERN.test(version) ? version : null;
}

export interface ClientVersionCount {
  readonly version: string;
  readonly sockets: number;
}

/**
 * The top builds by connected sockets, then `other` for the rest and `none`
 * for sockets without a build, so the metric has at most N + 2 values.
 */
export function summarizeClientVersions(
  rows: readonly { client_version: string | null; sockets: number | string }[],
  topN = CLIENT_VERSION_TOP_N
): ClientVersionCount[] {
  const named = rows
    .filter(
      (row): row is { client_version: string; sockets: number | string } =>
        row.client_version !== null &&
        CLIENT_VERSION_PATTERN.test(row.client_version)
    )
    .map((row) => ({
      version: row.client_version,
      sockets: Number(row.sockets)
    }))
    .sort(
      (a, b) => b.sockets - a.sockets || a.version.localeCompare(b.version)
    );
  const none = rows
    .filter(
      (row) =>
        row.client_version === null ||
        !CLIENT_VERSION_PATTERN.test(row.client_version)
    )
    .reduce((sum, row) => sum + Number(row.sockets), 0);
  const other = named.slice(topN).reduce((sum, row) => sum + row.sockets, 0);
  return [
    ...named.slice(0, topN),
    ...(other > 0 ? [{ version: CLIENT_VERSION_OTHER, sockets: other }] : []),
    ...(none > 0 ? [{ version: CLIENT_VERSION_NONE, sockets: none }] : [])
  ];
}

export class WsClientVersionsDb extends LazyDbAccessCompatibleService {
  /**
   * Connected sockets per declared build. Typing-only sockets are left out
   * (the same filter as broadcast audiences), so this counts one socket per
   * open app, and sockets with any future non-typing purpose still count.
   */
  async countPrimarySocketsByClientVersion(): Promise<
    { client_version: string | null; sockets: number }[]
  > {
    return this.db.execute(
      `select ws.client_version, count(*) as sockets
       from ${WS_CONNECTIONS_TABLE} ws
       where ${broadcastPurposeFilterSql('ws')}
       group by ws.client_version`
    );
  }
}

export const wsClientVersionsDb = new WsClientVersionsDb(dbSupplier);

const logger = Logger.get('WS_CLIENT_VERSIONS');

/**
 * One gauge per run: `ConnectedSockets` by `ClientVersion` (top builds,
 * `other`, `none`) plus the total, as EMF log lines (no CloudWatch API
 * call or IAM change). Best effort: a failure is logged, never thrown. If a
 * log write fails part-way, the lines already written stay; one missed
 * minute of a gauge is acceptable.
 */
export async function recordClientVersionGauge({
  db = wsClientVersionsDb,
  write = (line: string) => process.stdout.write(line),
  now = () => Date.now()
}: {
  db?: Pick<WsClientVersionsDb, 'countPrimarySocketsByClientVersion'>;
  write?: (line: string) => void;
  now?: () => number;
} = {}): Promise<ClientVersionCount[] | null> {
  try {
    const counts = summarizeClientVersions(
      await db.countPrimarySocketsByClientVersion()
    );
    const timestamp = now();
    const record = (
      dimensions: string[][],
      fields: Record<string, string | number>
    ) =>
      write(
        `${JSON.stringify({
          _aws: {
            Timestamp: timestamp,
            CloudWatchMetrics: [
              {
                Namespace: '6529/WebSocket',
                Dimensions: dimensions,
                Metrics: [{ Name: 'ConnectedSockets', Unit: 'Count' }]
              }
            ]
          },
          ...fields
        })}\n`
      );
    for (const { version, sockets } of counts) {
      record([['ClientVersion']], {
        ClientVersion: version,
        ConnectedSockets: sockets
      });
    }
    record([[]], {
      ConnectedSockets: counts.reduce((sum, row) => sum + row.sockets, 0)
    });
    return counts;
  } catch (error) {
    logger.warn(
      `Client version gauge skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}
