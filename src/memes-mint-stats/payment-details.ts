import {
  DROP_METADATA_TABLE,
  MEMES_CONTRACT,
  MINTING_CLAIMS_TABLE
} from '@/constants';
import type { MemesMintStatPaymentDetails } from '@/entities/IMemesMintStat';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';

type PaymentDetailsRow = {
  payment_details: string | null;
};

const logger = Logger.get('MEMES_MINT_PAYMENT_DETAILS');

/**
 * Canonical parser for memes-mint payment details.
 *
 * Accepts either the raw JSON string stored in `drop_metadata.data_value` or
 * an already-parsed object (e.g. from a `json` TypeORM column). Applies the
 * same validation and defaulting rules everywhere and returns `null` when the
 * input is missing or malformed.
 */
export function parseMemesMintPaymentDetails(
  raw: string | MemesMintStatPaymentDetails | null | undefined
): MemesMintStatPaymentDetails | null {
  let parsed: unknown;
  if (raw == null) {
    return null;
  }
  if (typeof raw === 'string') {
    if (raw === '') {
      return null;
    }
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn('Failed to parse payment_details JSON', {
        raw: raw.slice(0, 200),
        err
      });
      return null;
    }
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
    candidate.has_designated_payee === true ||
    candidate.has_designated_payee === 1;
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

export async function fetchPaymentDetailsForMemeToken(
  tokenId: number
): Promise<MemesMintStatPaymentDetails | null> {
  const row = await sqlExecutor.oneOrNull<PaymentDetailsRow>(
    `SELECT dm.data_value AS payment_details
     FROM ${MINTING_CLAIMS_TABLE} mc
     JOIN ${DROP_METADATA_TABLE} dm
       ON dm.drop_id = mc.drop_id
      AND dm.data_key = 'payment_info'
     WHERE mc.contract = :contract
       AND mc.claim_id = :tokenId
     ORDER BY dm.id DESC
     LIMIT 1`,
    {
      contract: MEMES_CONTRACT.toLowerCase(),
      tokenId
    }
  );

  return parseMemesMintPaymentDetails(row?.payment_details ?? null);
}
