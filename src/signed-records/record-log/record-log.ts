import { deviceSignedWritesService } from '@/api/device-signing/device-signed-writes.service';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { arweaveFileUploader } from '@/arweave';
import { ipfsFileUploader } from '@/attachments/ipfs-file-uploader';
import { deviceGrantProofSource } from '../record-grants';
import { loadProviderKeys } from '../sealed-crypto';
import { recordLogDb } from './record-log.db';
import { RecordLogSegmenter, RecordLogWriter } from './record-log.service';
import {
  loadServiceIdentity,
  SignedServiceDropPoster
} from './records-wave-poster';

const SEGMENT_CONTENT_TYPE = 'application/x-ndjson';

/**
 * The writer the lanes append to, in their own transactions. Entries wait
 * in signed_record_log_entries until the loop closes a segment; with the
 * loop off they wait, and nothing is lost.
 */
export const recordLog = new RecordLogWriter(
  recordLogDb,
  deviceGrantProofSource
);

/** The loop's segmenter, from config. Throws when the identity or keys are missing. */
export function createRecordLogSegmenter(
  env: Readonly<Record<string, string | undefined>> = process.env
): RecordLogSegmenter {
  const identity = loadServiceIdentity(env);
  if (!identity) {
    throw new Error('The signed records service identity is not configured');
  }
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (providers.length === 0) {
    throw new Error('SIGNED_RECORDS_PROVIDER_KEYS is not configured');
  }
  return new RecordLogSegmenter({
    store: recordLogDb,
    providers,
    pinner: {
      pin: async (bytes, name) =>
        (
          await ipfsFileUploader.uploadFile({
            fileName: name,
            fileBuffer: bytes,
            contentType: SEGMENT_CONTENT_TYPE
          })
        ).cid
    },
    archiver: {
      upload: async (bytes) =>
        (
          await arweaveFileUploader.uploadFileWithTransactionId(
            bytes,
            SEGMENT_CONTENT_TYPE
          )
        ).transaction_id
    },
    poster: new SignedServiceDropPoster(identity, {
      signedWrites: deviceSignedWritesService,
      dropCreation: dropCreationService
    })
  });
}
