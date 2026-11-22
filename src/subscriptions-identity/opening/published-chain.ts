import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { OPENING_STATE_ID } from '../identity/identity-switch';
import { BuildEffects } from '../writers/identity-daily-build';
import { canonicalJson, sha256Hex } from './opening-file';

/*
 * The identity tables' published chain, which a rebuild walks back from its
 * head: the opening file (with its history file), then one build record per
 * daily build after the switch, each naming the file before it by URI and
 * sha256. Files are uploaded where the final lists already go (Arweave), so
 * each is fetched by URI and checked against the hash its successor names.
 */

export const BUILD_RECORD_FORMAT = '6529-subscriptions-build/1';

export interface FileUploader {
  uploadFile(buffer: Buffer, contentType: string): Promise<{ url: string }>;
}

export interface ChainLink {
  readonly uri: string;
  readonly sha256: string;
  /** Set when the link is the opening file: where its history file is. */
  readonly historyUri?: string;
}

export interface BuildRecord {
  readonly format: typeof BUILD_RECORD_FORMAT;
  readonly previous: ChainLink;
  /** The published list file (CSV) for the card. */
  readonly listUri: string;
  readonly effects: BuildEffects;
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
  },
  uploader?: FileUploader
): Promise<{ openingUri: string; historyUri: string }> {
  const up = uploader ?? (await defaultUploader());
  const { url: historyUri } = await up.uploadFile(
    Buffer.from(files.historyBytes, 'utf8'),
    'application/json'
  );
  const { url: openingUri } = await up.uploadFile(
    Buffer.from(files.openingBytes, 'utf8'),
    'application/json'
  );
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET opening_uri = :openingUri, history_uri = :historyUri,
            head_uri = :openingUri, head_sha256 = :sha
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

/**
 * Publishes a daily build's record after its list, naming the chain's head
 * before it, and makes it the head. Refuses if the opening was never
 * published (no head).
 */
export async function publishBuildRecord(
  effects: BuildEffects,
  listUri: string,
  uploader?: FileUploader
): Promise<ChainLink> {
  const [state] = await sqlExecutor.execute<{
    head_uri: string | null;
    head_sha256: string | null;
    opening_sha256: string;
    history_uri: string | null;
  }>(
    `SELECT head_uri, head_sha256, opening_sha256, history_uri
       FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID }
  );
  if (!state?.head_uri || !state.head_sha256) {
    throw new Error(
      'The opening file was never published; a build record has nothing to name'
    );
  }
  const previous: ChainLink =
    state.head_sha256 === state.opening_sha256
      ? {
          uri: state.head_uri,
          sha256: state.head_sha256,
          historyUri: state.history_uri ?? undefined
        }
      : { uri: state.head_uri, sha256: state.head_sha256 };
  const record: BuildRecord = {
    format: BUILD_RECORD_FORMAT,
    previous,
    listUri,
    effects
  };
  const bytes = `${canonicalJson(record)}\n`;
  const sha256 = sha256Hex(bytes);
  const up = uploader ?? (await defaultUploader());
  const { url } = await up.uploadFile(
    Buffer.from(bytes, 'utf8'),
    'application/json'
  );
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET head_uri = :url, head_sha256 = :sha256
      WHERE id = :id AND head_sha256 = :previous`,
    { url, sha256, id: OPENING_STATE_ID, previous: previous.sha256 }
  );
  return { uri: url, sha256 };
}
