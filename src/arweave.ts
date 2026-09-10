import Arweave from 'arweave';
import type {
  SerializedUploader,
  TransactionUploader
} from 'arweave/node/lib/transaction-uploader';
import { Logger } from './logging';

export type ArweaveUploadState = Omit<SerializedUploader, 'transaction'> & {
  transaction: Record<string, unknown> & { id: string };
  data_base64: string;
};

export type ArweaveUploadHooks = {
  savedState?: ArweaveUploadState;
  onState(state: ArweaveUploadState): Promise<void>;
};

let arweaveAndKey: { arweave: Arweave; key: any } | null = null;

export function getArweaveInstance(): { arweave: Arweave; key: any } {
  if (!arweaveAndKey) {
    if (!process.env.ARWEAVE_KEY) {
      throw new Error('ARWEAVE_KEY not set');
    }
    const arweaveKey = JSON.parse(process.env.ARWEAVE_KEY);
    const arweave = Arweave.init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https'
    });
    arweaveAndKey = { arweave, key: arweaveKey };
  }
  return arweaveAndKey;
}

export class ArweaveFileUploader {
  private readonly logger = Logger.get(ArweaveFileUploader.name);

  constructor(
    private readonly arweaveAndKeySupplier: () => { arweave: Arweave; key: any }
  ) {}

  public async uploadFile(
    fileBuffer: Buffer,
    contentType: string
  ): Promise<{ url: string }> {
    const { url } = await this.uploadFileWithTransactionId(
      fileBuffer,
      contentType
    );
    return { url };
  }

  public async uploadFileWithTransactionId(
    fileBuffer: Buffer,
    contentType: string,
    hooks?: ArweaveUploadHooks
  ): Promise<{ url: string; transaction_id: string }> {
    const { arweave, key: arweaveKey } = this.arweaveAndKeySupplier();
    const uploader = hooks?.savedState
      ? await resumeUpload(arweave, hooks.savedState)
      : await createSignedUpload(arweave, arweaveKey, fileBuffer, contentType);
    const dataBase64 = Buffer.from(uploader.data).toString('base64');
    const transactionId = uploader.toJSON().transaction.id;

    // A failed checkpoint must prevent submission. The signed transaction and
    // its original bytes are the durable identity for every later retry.
    await hooks?.onState(serializeUpload(uploader, dataBase64));

    while (!uploader.isComplete) {
      await uploader.uploadChunk();
      await hooks?.onState(serializeUpload(uploader, dataBase64));
      this.logger.info(
        `Arweave upload ${transactionId} ${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
      );
    }
    const url = `https://arweave.net/${transactionId}`;
    return { url, transaction_id: transactionId };
  }
}

async function createSignedUpload(
  arweave: Arweave,
  key: Parameters<Arweave['createTransaction']>[1],
  fileBuffer: Buffer,
  contentType: string
): Promise<TransactionUploader> {
  const data = new Uint8Array(
    fileBuffer.buffer,
    fileBuffer.byteOffset,
    fileBuffer.byteLength
  );
  const transaction = await arweave.createTransaction({ data }, key);
  transaction.addTag('Content-Type', contentType);
  await arweave.transactions.sign(transaction, key);
  return arweave.transactions.getUploader(transaction);
}

async function resumeUpload(
  arweave: Arweave,
  state: ArweaveUploadState
): Promise<TransactionUploader> {
  const data = Buffer.from(state.data_base64, 'base64');
  if (data.toString('base64') !== state.data_base64) {
    throw new Error('Invalid persisted Arweave upload data');
  }
  let txPosted = state.txPosted;
  if (!txPosted) {
    const status = await arweave.transactions.getStatus(state.transaction.id);
    if (status.status === 200 || status.status === 202) txPosted = true;
    else if (status.status !== 404) {
      throw new Error(
        `Unable to verify persisted Arweave transaction: ${status.status}`
      );
    }
  }
  // getUploader restores the signed transaction, rebuilds chunk proofs from
  // the saved bytes and validates their data root. Never sign a replacement.
  return arweave.transactions.getUploader({ ...state, txPosted }, data);
}

function serializeUpload(
  uploader: TransactionUploader,
  dataBase64: string
): ArweaveUploadState {
  // Library toJSON serializes public transaction fields only. JSON-cloning
  // also detaches mutable uploader state from an in-flight DB checkpoint.
  const serialized = JSON.parse(JSON.stringify(uploader)) as Omit<
    ArweaveUploadState,
    'data_base64'
  >;
  return { ...serialized, data_base64: dataBase64 };
}

export const arweaveFileUploader = new ArweaveFileUploader(getArweaveInstance);
