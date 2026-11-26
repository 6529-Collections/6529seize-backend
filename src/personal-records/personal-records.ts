import { DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS } from '@/api/device-signing/device-signed-writes.service';
import { recordAnchorService } from '@/signed-records/record-anchor';
import { deviceGrantRecordSource } from '@/signed-records/record-grants';
import { RecordRegistry } from '@/signed-records/record-index';
import { recordLog } from '@/signed-records/record-log/record-log';
import { loadProviderKeys, ProviderKey } from '@/signed-records/sealed-crypto';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import {
  PersonalHandlerDeps,
  registerPersonalRecordTypes
} from './personal-record-types';
import { PersonalRecordsService } from './personal-records.service';
import { personalLiveEffects, personalTables } from './personal-records.wiring';
import { personalRecordsStateDb } from './personal-records-state.db';
import { recordOwnerDirectory } from './record-owner-directory';

const handlerDeps: PersonalHandlerDeps = {
  owners: recordOwnerDirectory,
  tables: personalTables,
  live: personalLiveEffects
};

let providerKeys: readonly ProviderKey[] | null = null;

/** The provider private keys (env SIGNED_RECORDS_PROVIDER_KEYS), read once. */
export function personalProviderKeys(): readonly ProviderKey[] {
  providerKeys ??= loadProviderKeys(process.env.SIGNED_RECORDS_PROVIDER_KEYS);
  return providerKeys;
}

const primaryRegistry = registerPersonalRecordTypes(
  new RecordRegistry(),
  handlerDeps
);

export const personalRecordsService = new PersonalRecordsService({
  grants: deviceGrantRecordSource,
  owners: recordOwnerDirectory,
  anchors: recordAnchorService,
  heads: signedRecordHeadsDb,
  registry: primaryRegistry,
  providers: personalProviderKeys,
  log: recordLog,
  importOrder: async () => (await personalRecordsStateDb.read()).importOrder,
  maxClockSkewMs: DEVICE_SIGNATURE_MAX_CLOCK_SKEW_MS
});
