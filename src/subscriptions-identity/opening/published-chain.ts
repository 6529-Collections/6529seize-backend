import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { OPENING_STATE_ID } from '../identity/identity-switch';

/*
 * The opening and history files are uploaded where the final lists already
 * go (Arweave), tagged so they can be found by a tag query. Go-live names
 * them, by URI and sha256, in the journal's `opening` entry, written in
 * the switch's transaction; a rebuild starts from that entry, which the
 * records wave carries.
 */

export const UPLOAD_APP_NAME = '6529-subscriptions';

export interface FileUploader {
  uploadFile(
    buffer: Buffer,
    contentType: string,
    tags?: Readonly<Record<string, string>>
  ): Promise<{ url: string }>;
}

async function defaultUploader(): Promise<FileUploader> {
  const { arweaveFileUploader } = await import('@/arweave');
  return arweaveFileUploader;
}

/** Uploads the opening and history files and records where they are. */
export async function publishOpeningFiles(
  files: {
    readonly openingBytes: string;
    readonly historyBytes: string;
    readonly openingSha256: string;
    readonly historySha256: string;
  },
  uploader?: FileUploader
): Promise<{ openingUri: string; historyUri: string }> {
  const up = uploader ?? (await defaultUploader());
  const tags = (kind: string, sha256: string) => ({
    'App-Name': UPLOAD_APP_NAME,
    Kind: kind,
    'Opening-Sha256': files.openingSha256,
    Sha256: sha256
  });
  const { url: historyUri } = await up.uploadFile(
    Buffer.from(files.historyBytes, 'utf8'),
    'application/json',
    tags('history', files.historySha256)
  );
  const { url: openingUri } = await up.uploadFile(
    Buffer.from(files.openingBytes, 'utf8'),
    'application/json',
    tags('opening', files.openingSha256)
  );
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET opening_uri = :openingUri, history_uri = :historyUri
      WHERE id = :id AND opening_sha256 = :sha`,
    {
      openingUri,
      historyUri,
      sha: files.openingSha256,
      id: OPENING_STATE_ID
    }
  );
  return { openingUri, historyUri };
}
