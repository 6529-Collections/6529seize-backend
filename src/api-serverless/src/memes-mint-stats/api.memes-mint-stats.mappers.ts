import type { ApiMemesMintStat } from '@/api/generated/models/ApiMemesMintStat';
import type { ApiPaymentDetails } from '@/api/generated/models/ApiPaymentDetails';
import type { MemesMintStatPaymentDetails } from '@/entities/IMemesMintStat';
import { Logger } from '@/logging';

export type ApiMemesMintStatRow = Omit<ApiMemesMintStat, 'payment_details'> & {
  payment_details: string | MemesMintStatPaymentDetails | null;
};

function safeParseJson<T>(raw: string | null, fallback: T, label: string): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    Logger.get('api.memes-mint-stats.mappers').warn(
      `Failed to parse ${label}`,
      {
        raw: raw.slice(0, 200),
        err
      }
    );
    return fallback;
  }
}

function safeParsePaymentDetails(
  raw: string | MemesMintStatPaymentDetails | null | undefined
): ApiPaymentDetails | null {
  let parsed: unknown;
  if (typeof raw === 'string') {
    parsed = safeParseJson<unknown>(raw, null, 'payment_details');
  } else if (raw == null) {
    parsed = null;
  } else {
    parsed = raw;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.payment_address !== 'string') {
    return null;
  }

  const hasDesignatedPayee =
    typeof candidate.has_designated_payee === 'boolean'
      ? candidate.has_designated_payee
      : false;
  const designatedPayeeName =
    typeof candidate.designated_payee_name === 'string'
      ? candidate.designated_payee_name
      : '';

  return {
    payment_address: candidate.payment_address,
    has_designated_payee: hasDesignatedPayee,
    designated_payee_name: designatedPayeeName
  };
}

export function rowToApiMemesMintStat(
  row: ApiMemesMintStatRow
): ApiMemesMintStat {
  return {
    ...row,
    payment_details: safeParsePaymentDetails(row.payment_details)
  };
}
