import { marketReceiptDto } from './marketplace-receipt.dto';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';
import { MARKET_WETH } from '@/marketplace/seaport.registry';

describe('market receipt API evidence', () => {
  it('serializes payout currency separately from actual ETH costs and retains the correct payer wallet', () => {
    const payer = `0x${'11'.repeat(20)}`,
      payout = `0x${'22'.repeat(20)}`;
    const dto = marketReceiptDto({
      transactions: [
        {
          purpose: 'TRANSACTION',
          from: payer,
          transactionHash: `0x${'ab'.repeat(32)}`,
          blockNumber: 100,
          blockHash: `0x${'cd'.repeat(32)}`,
          blockTimestamp: 1800000000,
          status: 'SUCCESS',
          confirmation: 'CONFIRMED',
          gasUsed: '25000',
          effectiveGasPriceWei: '9',
          networkFeeWei: '225000'
        }
      ],
      payment: {
        currency: MARKET_WETH,
        totalWei: '200',
        netWei: '198',
        fees: [{ recipient: payer, amountWei: '2' }],
        payoutWallet: payout
      }
    });
    const wire = ObjectSerializer.serialize(
      dto,
      'ApiMarketReceipt',
      ''
    ) as Record<string, unknown>;
    expect(wire).toMatchObject({
      transactions: [
        {
          payer_wallet: payer,
          network_fee_wei: '225000',
          block_timestamp: 1800000000
        }
      ],
      payment: {
        currency: MARKET_WETH,
        total_wei: '200',
        net_wei: '198',
        payout_wallet: payout
      }
    });
    expect(JSON.stringify(wire)).not.toContain('gas_reserve');
    expect(JSON.stringify(wire)).not.toContain('_from');
  });
  it('does not invent unknown fee fields or a payment on an approval-only receipt', () => {
    const dto = marketReceiptDto({
      transactions: [
        {
          purpose: 'APPROVAL',
          from: `0x${'11'.repeat(20)}`,
          transactionHash: `0x${'ab'.repeat(32)}`,
          blockNumber: 100,
          blockHash: `0x${'cd'.repeat(32)}`,
          blockTimestamp: 1800000000,
          status: 'SUCCESS',
          confirmation: 'CONFIRMED'
        }
      ]
    });
    expect(dto).not.toHaveProperty('payment');
    expect(dto.transactions[0]).not.toHaveProperty('network_fee_wei');
    expect(dto.transactions[0]).not.toHaveProperty('gas_used');
  });
});
