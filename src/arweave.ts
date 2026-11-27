import { arweaveContentUrl } from '@/arweave/gateways';
import { createArweaveClient } from '@/arweave/client';
import { ArweaveUploadSession } from '@/arweave/upload';
import type { JWKInterface } from 'arweave/node/lib/wallet';
import Arweave from 'arweave';
import type { SerializedUploader } from 'arweave/node/lib/transaction-uploader';
import { Logger } from './logging';

export type ArweaveUploadState = Omit<SerializedUploader, 'transaction'> & {
  transaction: Record<string, unknown> & { id: string };
  data_base64: string;
};

export type ArweaveUploadHooks = {
  savedState?: ArweaveUploadState;
  // Compact consumers persist source identity separately and provide the exact
  // verified source bytes on resume. Other consumers retain embedded bytes.
  useSourceData?: boolean;
  // Persistence must fence writes against replacement attempts: cancellation
  // releases the caller's wait but cannot undo a write already sent to a DB.
  onState(
    state: ArweaveUploadState,
    context: { signal: AbortSignal }
  ): Promise<void>;
};

export type ArweaveUploadOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

let arweaveAndKey: { arweave: Arweave; key: any } | null = null;

export function getArweaveInstance(): { arweave: Arweave; key: any } {
  if (!arweaveAndKey) {
    if (!process.env.ARWEAVE_KEY) {
      throw new Error('ARWEAVE_KEY not set');
    }
    const arweaveKey = JSON.parse(process.env.ARWEAVE_KEY);
    const arweave = createArweaveClient();
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
    contentType: string,
    tags?: Readonly<Record<string, string>>
  ): Promise<{ url: string }> {
    const { url } = await this.uploadFileWithTransactionId(
      fileBuffer,
      contentType,
      undefined,
      tags
    );
    return { url };
  }

  public async uploadFileWithTransactionId(
    fileBuffer: Buffer,
    contentType: string,
    hooks?: ArweaveUploadHooks,
    tags?: Readonly<Record<string, string>>,
    options: ArweaveUploadOptions = {}
  ): Promise<{ url: string; transaction_id: string }> {
    const { arweave, key: arweaveKey } = this.arweaveAndKeySupplier();
    const result = await new ArweaveUploadSession(
      this.logger,
      arweave,
      Math.min(options.timeoutMs ?? 600_000, 600_000),
      true,
      tags
    ).upload(
      fileBuffer,
      arweaveKey as JWKInterface,
      contentType,
      hooks,
      options.signal
    );
    return {
      url: arweaveContentUrl(result.transactionId),
      transaction_id: result.transactionId
    };
  }
}

export const arweaveFileUploader = new ArweaveFileUploader(getArweaveInstance);
