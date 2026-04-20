import {
  DROP_METADATA_TABLE,
  MEMES_CONTRACT,
  MINTING_CLAIMS_TABLE
} from '@/constants';
import type { MemesMintStatPaymentDetails } from '@/entities/IMemesMintStat';
import { sqlExecutor } from '@/sql-executor';

type PaymentDetailsRow = {
  payment_details: string | null;
};

function parsePaymentDetails(
  raw: string | null
): MemesMintStatPaymentDetails | null {
  if (raw == null || raw === '') {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.payment_address !== 'string') {
      return null;
    }

    const hasDesignatedPayee =
      typeof parsed.has_designated_payee === 'boolean'
        ? parsed.has_designated_payee
        : false;
    const designatedPayeeName =
      typeof parsed.designated_payee_name === 'string'
        ? parsed.designated_payee_name
        : '';

    return {
      payment_address: parsed.payment_address,
      has_designated_payee: hasDesignatedPayee,
      designated_payee_name: designatedPayeeName
    };
  } catch {
    return null;
  }
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
     LIMIT 1`,
    {
      contract: MEMES_CONTRACT.toLowerCase(),
      tokenId
    }
  );

  return parsePaymentDetails(row?.payment_details ?? null);
}
