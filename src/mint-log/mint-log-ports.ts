import type { RequestContext } from '@/request.context';
import { defaultMintLogPorts } from './mint-log-signed-records';

/**
 * What the mint log uses from the shared signed-records module
 * (`@/signed-records`): record verification and the record log.
 * Until the ports are bound, primary mode refuses admin writes and shadow
 * mode logs nothing.
 */

/** A verified kind 9 RECORD, reduced to what the mint log checks. */
export interface MintVerifiedRecord {
  readonly eventId: string;
  /** The grant wallet, lowercase. */
  readonly author: string;
  readonly refs: readonly string[];
  readonly body: Record<string, unknown> | null;
  /** The event as received, appended to the record log. */
  readonly event: unknown;
}

export type MintRecordVerifyResult =
  | { readonly ok: true; readonly record: MintVerifiedRecord }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface MintSignedRecordsPort {
  /** `decodeSignedRecordsHeader`: throws on a malformed header. */
  decodeHeader(value: string): unknown[];
  /** `verifyRecordEvent` with 6529.io's grant and binding sources. */
  verify(event: unknown): Promise<MintRecordVerifyResult>;
  /** The grant proof the record log stores beside the event. */
  grantProof(record: MintVerifiedRecord): Promise<unknown>;
}

export type MintRecordLogEntry =
  | {
      readonly t: 'event';
      readonly lane: string;
      readonly event: unknown;
      readonly grant: unknown;
    }
  | {
      readonly t: 'entry';
      readonly lane: string;
      /** Mint entries hold public data only. */
      readonly chain: 'public';
      readonly body: Record<string, unknown>;
    };

export interface MintRecordLogPort {
  /** `recordLog.append`: queues entries in the caller's transaction. */
  append(
    entries: readonly MintRecordLogEntry[],
    ctx: RequestContext
  ): Promise<void>;
}

export interface MintLogPorts {
  readonly records: MintSignedRecordsPort | null;
  readonly log: MintRecordLogPort | null;
}

/**
 * The ports in use: the shared module's. Read on each write, so a verifier
 * bound later (once the gateway client is set) takes effect at once.
 */
export function getMintLogPorts(): MintLogPorts {
  return defaultMintLogPorts();
}
