import { REMEMES_UPLOADS, ROYALTIES_UPLOADS_TABLE } from '@/constants';
import { mintCard } from './mint-log-parts';
import { MintLogRecorder, mintLogRecorder } from './mint-log-recorder';
import { UPLOADS_CARD_CONTRACT } from './mint-log.types';

export type MintReceiptTable =
  | typeof REMEMES_UPLOADS
  | typeof ROYALTIES_UPLOADS_TABLE;

/**
 * Logs the receipt of a file a loop published to Arweave (the daily rememes
 * and royalties CSVs) on the rememes chain. The row is the receipt: a
 * rebuild takes it from the entry, since the upload cannot be redone.
 */
export function logPublicationReceipt(
  table: MintReceiptTable,
  loop: string,
  receipt: Record<string, unknown>,
  write: () => Promise<void>,
  recorder: Pick<MintLogRecorder, 'write'> = mintLogRecorder
): Promise<void> {
  return recorder.write(
    {
      kind: 'publication.receipt',
      card: mintCard(UPLOADS_CARD_CONTRACT, 0, table),
      actor: { type: 'service', wallet: null, authority: null },
      intent: { route: `loop ${loop}`, params: {}, body: receipt }
    },
    write
  );
}
