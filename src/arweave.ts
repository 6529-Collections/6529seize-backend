import { Logger } from './logging';

const Arweave = require('arweave');

let arweaveAndKey: { arweave: any; key: any } | null = null;

export function getArweaveInstance(): { arweave: any; key: any } {
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
    private readonly arweaveAndKeySupplier: () => { arweave: any; key: any }
  ) {}

  public async uploadFile(
    fileBuffer: Buffer,
    contentType: string
  ): Promise<{ url: string }> {
    const { arweave, key: arweaveKey } = this.arweaveAndKeySupplier();
    const areweaveTransaction = await arweave.createTransaction(
      { data: fileBuffer },
      arweaveKey
    );
    areweaveTransaction.addTag('Content-Type', contentType);

    await arweave.transactions.sign(areweaveTransaction, arweaveKey);

    const uploader =
      await arweave.transactions.getUploader(areweaveTransaction);

    while (!uploader.isComplete) {
      await uploader.uploadChunk();
      this.logger.info(
        `Arweave upload ${areweaveTransaction.id} ${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
      );
    }
    const url = `https://arweave.net/${areweaveTransaction.id}`;
    return { url };
  }
}

export const arweaveFileUploader = new ArweaveFileUploader(getArweaveInstance);
