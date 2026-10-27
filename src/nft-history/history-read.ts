import { NFTS_HISTORY_EVENTS_TABLE, NFTS_HISTORY_TABLE } from '@/constants';

export const HISTORY_PUBLIC_FIELDS =
  'nft_id, contract, uri, created_at, transaction_date, transaction_hash, block, description';

// Preserve the public response shape. An audited event supersedes only its
// matching legacy transaction, never every occurrence of its URI.
export function historyReadSource(): string {
  return `(
    SELECT ${HISTORY_PUBLIC_FIELDS}, transaction_index, log_index
    FROM ${NFTS_HISTORY_EVENTS_TABLE}
    WHERE contract=:contract AND nft_id=:nft_id AND description IS NOT NULL
    UNION ALL
    SELECT ${HISTORY_PUBLIC_FIELDS.split(', ')
      .map((field) => `legacy.${field}`)
      .join(', ')}, -1 AS transaction_index, -1 AS log_index
    FROM ${NFTS_HISTORY_TABLE} legacy
    WHERE legacy.contract=:contract AND legacy.nft_id=:nft_id
      AND NOT EXISTS (
        SELECT 1 FROM ${NFTS_HISTORY_EVENTS_TABLE} event
        WHERE event.contract=legacy.contract AND event.nft_id=legacy.nft_id
          AND LOWER(event.transaction_hash)=LOWER(legacy.transaction_hash)
      )
  ) history`;
}
