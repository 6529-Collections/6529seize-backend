import { ApiMarketReceipt } from '@/api/generated/models/ApiMarketReceipt';
import {
  ApiMarketReceiptTransactionPurposeEnum,
  ApiMarketReceiptTransactionStatusEnum,
  ApiMarketReceiptTransactionConfirmationEnum
} from '@/api/generated/models/ApiMarketReceiptTransaction';
import { MarketReceipt } from '@/marketplace/market-receipt-evidence';

export function marketReceiptDto(receipt: MarketReceipt): ApiMarketReceipt {
  return {
    transactions: receipt.transactions.map((entry) => ({
      purpose: entry.purpose as ApiMarketReceiptTransactionPurposeEnum,
      payer_wallet: entry.from,
      transaction_hash: entry.transactionHash,
      block_number: entry.blockNumber,
      block_hash: entry.blockHash,
      block_timestamp: entry.blockTimestamp,
      status: entry.status as ApiMarketReceiptTransactionStatusEnum,
      confirmation:
        entry.confirmation as ApiMarketReceiptTransactionConfirmationEnum,
      ...(entry.safeBlockNumber === undefined
        ? {}
        : { safe_block_number: entry.safeBlockNumber }),
      ...(entry.gasUsed === undefined ? {} : { gas_used: entry.gasUsed }),
      ...(entry.effectiveGasPriceWei === undefined
        ? {}
        : { effective_gas_price_wei: entry.effectiveGasPriceWei }),
      ...(entry.networkFeeWei === undefined
        ? {}
        : { network_fee_wei: entry.networkFeeWei })
    })),
    ...(receipt.payment
      ? {
          payment: {
            currency: receipt.payment.currency,
            total_wei: receipt.payment.totalWei,
            net_wei: receipt.payment.netWei,
            fees: receipt.payment.fees.map((fee) => ({
              recipient: fee.recipient,
              amount_wei: fee.amountWei
            })),
            ...(receipt.payment.payoutWallet
              ? { payout_wallet: receipt.payment.payoutWallet }
              : {})
          }
        }
      : {})
  };
}
