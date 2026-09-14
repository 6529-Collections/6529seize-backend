import { describeMarketOrder } from '@/marketplace/provider.opensea';
import { discoveredOrderDto } from '@/api/marketplace/marketplace.dto';
import { marketBatchFixture } from '@/marketplace/market-batch.test-fixture';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import { TypedDataEncoder } from 'ethers';

function describeFixture(orderType: number, fee: string) {
  const f = marketBatchFixture(),
    line = f.intent.items[1],
    order = f.materials[1].order;
  const c = order.components;
  c.offer[0].startAmount = c.offer[0].endAmount = '2';
  c.consideration[0].startAmount = c.consideration[0].endAmount = (
    BigInt(200) - BigInt(fee)
  ).toString();
  c.consideration[1].startAmount = c.consideration[1].endAmount = fee;
  c.orderType = orderType;
  const identity = {
    protocolAddress: order.protocolAddress,
    orderHash: TypedDataEncoder.hashStruct(
      'OrderComponents',
      SEAPORT_ORDER_TYPES,
      c
    )
  };
  return {
    line,
    result: describeMarketOrder(
      { identity, components: c, signature: '0x1122' },
      line.intent.asset,
      'LISTING',
      '2'
    )
  };
}
describe('executable discovery quantities', () => {
  test.each([
    [0, '2'],
    [1, '1']
  ])('offers full remaining lot for type %s fee %s', (type, fee) => {
    const { line, result } = describeFixture(Number(type), String(fee));
    expect(result.unitTotalWei).toBeUndefined();
    expect(discoveredOrderDto(result, line.assetKey)).toMatchObject({
      quantity: '2',
      purchase_quantity: '2',
      quantity_step: '2',
      available_quantity: '2',
      total_wei: '200'
    });
  });
  test('allows exact unit fills only when every individual payment scales exactly', () => {
    const { line, result } = describeFixture(1, '2');
    expect(result.unitTotalWei).toBe('100');
    expect(discoveredOrderDto(result, line.assetKey)).toMatchObject({
      quantity: '2',
      purchase_quantity: '1',
      quantity_step: '1',
      available_quantity: '2',
      total_wei: '200'
    });
  });
  test('keeps normalized quote basis separate from actual remaining availability', () => {
    const { line, result } = describeFixture(1, '2');
    expect(
      discoveredOrderDto(
        {
          ...result,
          quantity: '1',
          availableQuantity: '2',
          totalWei: '100',
          netWei: '99',
          fees: [{ recipient: result.fees[0].recipient, amountWei: '1' }]
        },
        line.assetKey
      )
    ).toMatchObject({
      quantity: '1',
      available_quantity: '2',
      purchase_quantity: '1',
      quantity_step: '1',
      total_wei: '100'
    });
  });
});
