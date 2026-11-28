import { ArweaveUploadSession } from '@/arweave/upload';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { Logger } from '@/logging';

export async function uploadTdhCsvToArweave(
  csv: string,
  key: JWKInterface,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
): Promise<{ url: string; transactionId: string }> {
  return new ArweaveUploadSession(logger).upload(
    Buffer.from(csv),
    key,
    'text/csv'
  );
}
