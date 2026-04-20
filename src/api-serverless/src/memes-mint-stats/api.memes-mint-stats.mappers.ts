import type { ApiMemesMintStat } from '@/api/generated/models/ApiMemesMintStat';
import type { ApiPaymentDetails } from '@/api/generated/models/ApiPaymentDetails';
import type { MemesMintStatPaymentDetails } from '@/entities/IMemesMintStat';
import { parseMemesMintPaymentDetails } from '@/memes-mint-stats/payment-details';

export type ApiMemesMintStatRow = Omit<ApiMemesMintStat, 'payment_details'> & {
  payment_details: string | MemesMintStatPaymentDetails | null;
};

export function rowToApiMemesMintStat(
  row: ApiMemesMintStatRow
): ApiMemesMintStat {
  const parsed = parseMemesMintPaymentDetails(row.payment_details);
  return {
    ...row,
    payment_details: parsed as ApiPaymentDetails | null
  };
}
