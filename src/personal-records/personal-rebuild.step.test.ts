import { RecordKind } from '@/signed-records/record-kinds';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import type {
  RecordLogItem,
  RecordLogReader
} from '@/signed-records/record-log/record-log-reader';
import { importOrderKey } from '@/signed-records/record-order';
import {
  appGrantFixture,
  bindingSource,
  signedRecord,
  VECTORS
} from '@/signed-records/record-test-fixtures';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { personalManifest } from '@/rebuild/manifests/personal.manifest';
import type { PersonalRebuildReport } from './personal-import';
import {
  PersonalLogRead,
  readPersonalLog,
  rebuildPersonalTables,
  runPersonalRebuild
} from './personal-rebuild.step';

const inputs = VECTORS.inputs;

/** A reader that walks the given entries, public and private apart. */
function readerOf(
  chains: Record<'public' | 'private', RecordLogEntry[]>
): RecordLogReader {
  return {
    async *walk(chain: 'public' | 'private'): AsyncGenerator<RecordLogItem> {
      for (const entry of chains[chain]) {
        yield { head: {} as RecordLogItem['head'], entry };
      }
    }
  } as unknown as RecordLogReader;
}

const report = (
  changes: Partial<PersonalRebuildReport> = {}
): PersonalRebuildReport => ({
  importOrder: importOrderKey(1000, 5000),
  importEntries: 1,
  records: 1,
  beforeImport: 0,
  refused: [],
  ...changes
});

describe('readPersonalLog', () => {
  it('keeps the personal settings entries, each record verified against its own grant proof', async () => {
    const { proof, grant } = await appGrantFixture();
    const event = signedRecord(grant, {
      kind: RecordKind.RECORD,
      wave: `ps/${inputs.principal}`,
      refs: ['follow', `identity:${inputs.target}`],
      body: { actions: ['DROP_CREATED'] },
      seq: 1,
      anchor: 1001,
      claimedTime: Date.UTC(2026, 10, 26)
    });
    const importBody = {
      v: 1,
      anchor: 1000,
      at: 5000,
      owner: inputs.principal,
      family: 'pv',
      items: []
    };
    const read = await readPersonalLog(
      readerOf({
        public: [
          { t: 'event', lane: 'personal', event, grant: proof },
          // Entries of other features are left alone.
          { t: 'event', lane: 'subs', event, grant: proof },
          { t: 'entry', lane: 'subs', chain: 'public', body: { list: 'x' } }
        ],
        private: [
          {
            t: 'entry',
            lane: 'personal-import',
            chain: 'private',
            body: importBody
          },
          // A proof that does not verify.
          {
            t: 'event',
            lane: 'personal',
            event,
            grant: { ...proof, wallet_signature: `0x${'ab'.repeat(65)}` }
          }
        ]
      }),
      {
        bindings: bindingSource([
          { wallet: grant.wallet, principal: inputs.principal, from: 1 }
        ])
      }
    );
    expect(read.imports).toEqual([importBody]);
    expect(read.records.map((record) => record.event.id)).toEqual([event.id]);
    expect(read.rejected).toEqual({ 'grant-unknown': 1 });
  });
});

describe('runPersonalRebuild', () => {
  const read: PersonalLogRead = { imports: [], records: [], rejected: {} };

  it('fails on a refused or a rejected record, after rebuilding the rest', async () => {
    const setImport = jest.fn().mockResolvedValue(undefined);
    await expect(
      runPersonalRebuild({
        read,
        rebuild: async () =>
          report({ refused: [{ what: 'record 0x01', detail: 'rule: x' }] }),
        setImport
      })
    ).rejects.toThrow('left out 1 refused and 0 rejected records');
    await expect(
      runPersonalRebuild({
        read: { ...read, rejected: { 'grant-unknown': 2 } },
        rebuild: async () => report(),
        setImport
      })
    ).rejects.toThrow('left out 0 refused and 2 rejected records');
    expect(setImport).toHaveBeenCalledTimes(2);
  });
});

describe('rebuildPersonalTables', () => {
  it("takes the records wave 'none' as no records wave, and reads nothing", async () => {
    const ctx = {
      sources: { files: 'https://192.0.2.1' }
    } as unknown as RebuildContext;
    for (const wave of ['none', 'NONE', '']) {
      await expect(
        rebuildPersonalTables(ctx, {
          ...personalManifest.flags,
          SIGNED_RECORDS_WAVE_ID: wave
        })
      ).rejects.toThrow('no records wave set');
    }
  });
});
