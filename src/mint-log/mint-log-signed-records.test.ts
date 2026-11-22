import { encodeSignedRecordsHeader } from '@/signed-records/record-event';
import { familyWave } from '@/signed-records/record-families';
import { RecordKind } from '@/signed-records/record-kinds';
import { checkLogEntry } from '@/signed-records/record-log/record-log-format';
import {
  appGrantFixture,
  bindingSource,
  grantSource,
  signedRecord,
  VECTORS
} from '@/signed-records/record-test-fixtures';
import type { RecordGrantProof } from '@/signed-records/record-event';
import type { VerifiedGrant } from '@/signed-records/record-verify';
import {
  adminRecordBody,
  MINT_ADMIN_RECORD_TYPE,
  MintIntent,
  recordMismatch
} from './mint-log-intent';
import { emptyCardState } from './mint-log-diff';
import { MintLogRecorder } from './mint-log-recorder';
import { signedRecordsPort } from './mint-log-signed-records';
import { MINT_LOG_LANE } from './mint-log.types';

const { principal } = VECTORS.inputs;

const intent: MintIntent = {
  route: 'POST /distributions/:contract/:id/normalize',
  params: { contract: '0xabc', id: '100' },
  body: null
};

// A real app grant for the vectors' device key, and its proof.
let grant: VerifiedGrant;
let proof: RecordGrantProof;

beforeAll(async () => {
  ({ grant, proof } = await appGrantFixture());
});

function adminRecord(body: object | null) {
  return signedRecord(grant, {
    kind: RecordKind.RECORD,
    wave: familyWave('ps', principal),
    refs: [MINT_ADMIN_RECORD_TYPE, 'request-1'],
    body,
    seq: 1,
    anchor: 1000,
    claimedTime: 1795694700007
  });
}

function port(boundFrom = 0) {
  return signedRecordsPort({
    grants: grantSource([grant]),
    bindings: bindingSource([
      { wallet: grant.wallet, principal, from: boundFrom }
    ]),
    proofs: {
      findGrantProofs: async (ids) => (ids.includes(proof.id) ? [proof] : [])
    }
  });
}

describe('mint admin records through the shared module', () => {
  it('verifies a signed mint.admin record and matches it to the request', async () => {
    const event = adminRecord(adminRecordBody('dist.normalize', intent));
    const records = port();
    const [decoded] = records.decodeHeader(encodeSignedRecordsHeader([event]));
    const result = await records.verify(decoded);
    if (!result.ok) throw new Error(result.detail);
    expect(result.record).toMatchObject({
      eventId: event.id,
      author: grant.wallet,
      refs: [MINT_ADMIN_RECORD_TYPE, 'request-1']
    });
    expect(
      recordMismatch(result.record, 'dist.normalize', intent, grant.wallet)
    ).toBeNull();
    await expect(records.grantProof(result.record)).resolves.toEqual(proof);
  });

  it('refuses a record whose author is not bound to the stream owner', async () => {
    const event = adminRecord(adminRecordBody('dist.normalize', intent));
    const result = await port(2000).verify(event);
    expect(result).toMatchObject({ ok: false, reason: 'not-bound' });
  });

  it('refuses a record changed after signing', async () => {
    const event = adminRecord(adminRecordBody('dist.normalize', intent));
    const result = await port().verify({
      ...event,
      refs: [MINT_ADMIN_RECORD_TYPE, 'request-2']
    });
    expect(result.ok).toBe(false);
  });

  it('lets primary mode run a write signed by the signed-in admin', async () => {
    const event = adminRecord(adminRecordBody('dist.normalize', intent));
    const appended: unknown[] = [];
    const recorder = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => false,
        isMintLogPrimaryEnabled: () => true,
        isMintLogReplayCheckEnabled: () => false
      },
      () => ({
        records: port(),
        log: { append: async (entries) => void appended.push(...entries) }
      }),
      () =>
        ({
          executeNativeQueriesInTransaction: (fn: any) =>
            fn({ connection: 'tx' }),
          execute: async () => []
        }) as any,
      {
        capture: async () => emptyCardState()
      } as any,
      { apply: async () => undefined } as any,
      {
        lock: async () => ({ seq: -1, hash: null }),
        advance: async () => undefined
      } as any
    );
    await recorder.write(
      {
        kind: 'dist.normalize',
        card: { contract: '0xabc', card_id: 100 },
        actor: { type: 'admin', wallet: grant.wallet, authority: 'test' },
        intent,
        signedRecords: encodeSignedRecordsHeader([event])
      },
      async () => 'done'
    );
    // Both entries pass the shared log's own check.
    expect(appended).toHaveLength(2);
    for (const entry of appended) {
      expect(() => checkLogEntry(entry)).not.toThrow();
      expect((entry as { lane: string }).lane).toBe(MINT_LOG_LANE);
    }
  });
});
