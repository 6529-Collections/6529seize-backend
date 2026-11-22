import type { TDHBlockWithChainDay } from '@/db-api';
import { ApiBlockItem } from '../generated/models/ApiBlockItem';

/**
 * Where a TDH block's TDH comes from: the 6529 chain, when the chain-day
 * write recorded it (with the day number and wallet root), else 6529.io's
 * own computation. After a rollback the newer days read SITE again, and so
 * does a block the old path wrote again (`superseded_at`).
 */
export function blockSource(
  row: Pick<TDHBlockWithChainDay, 'chain_cycle_day' | 'chain_wallet_root'>
): Pick<ApiBlockItem, 'source' | 'cycle_day' | 'wallet_root'> {
  if (row.chain_cycle_day === null || row.chain_cycle_day === undefined) {
    return { source: 'SITE' };
  }
  return {
    source: 'CHAIN',
    cycle_day: Number(row.chain_cycle_day),
    ...(row.chain_wallet_root ? { wallet_root: row.chain_wallet_root } : {})
  };
}
