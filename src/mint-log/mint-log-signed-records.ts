import type { RequestContext } from '@/request.context';
import {
  decodeSignedRecordsHeader,
  SignedRecordEvent
} from '@/signed-records/record-event';
import {
  deviceGrantProofSource,
  deviceGrantRecordSource
} from '@/signed-records/record-grants';
import { recordLog } from '@/signed-records/record-log/record-log';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import type { GrantProofSource } from '@/signed-records/record-log/record-log.service';
import {
  PrincipalBindingSource,
  RecordGrantSource,
  verifyRecordEvent
} from '@/signed-records/record-verify';
import { getMintPrincipalBindings } from './mint-gateway';
import type {
  MintLogPorts,
  MintRecordLogPort,
  MintSignedRecordsPort,
  MintVerifiedRecord
} from './mint-log-ports';

function parseBody(body: string | null): Record<string, unknown> | null {
  if (body === null) return null;
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** The record verifier, over the shared module's checks and sources. */
export function signedRecordsPort(deps: {
  readonly bindings: PrincipalBindingSource;
  readonly grants?: RecordGrantSource;
  readonly proofs?: GrantProofSource;
}): MintSignedRecordsPort {
  const grants = deps.grants ?? deviceGrantRecordSource;
  const proofs = deps.proofs ?? deviceGrantProofSource;
  return {
    decodeHeader: (value) => decodeSignedRecordsHeader(value),
    verify: async (event) => {
      const result = await verifyRecordEvent(event, {
        grants,
        bindings: deps.bindings
      });
      if (!result.ok) return result;
      const verified = result.record.event;
      const record: MintVerifiedRecord = {
        eventId: verified.id,
        author: verified.author.toLowerCase(),
        refs: verified.refs,
        body: parseBody(verified.body),
        event: verified
      };
      return { ok: true, record };
    },
    grantProof: async (record) => {
      const event = record.event as SignedRecordEvent;
      const found = await proofs.findGrantProofs([event.auth_ref], {});
      const proof = found.find(
        (grant) => grant.id === event.auth_ref.toLowerCase()
      );
      if (!proof) {
        throw new Error(`No grant proof for record ${event.id}`);
      }
      return proof;
    }
  };
}

/** The shared record log, which queues entries in the caller's transaction. */
export const recordLogPort: MintRecordLogPort = {
  append: (entries, ctx: RequestContext) =>
    recordLog.append(entries as unknown as RecordLogEntry[], ctx)
};

/**
 * The ports the mint log uses. The record log is always bound.
 * The verifier also needs the principal a wallet was bound to at a height,
 * which the shared gateway client will provide; until then it stays unbound,
 * so shadow mode logs entries without checking records and primary mode
 * refuses admin writes.
 */
export function defaultMintLogPorts(
  bindings: PrincipalBindingSource | null = getMintPrincipalBindings()
): MintLogPorts {
  return {
    records: bindings ? signedRecordsPort({ bindings }) : null,
    log: recordLogPort
  };
}
