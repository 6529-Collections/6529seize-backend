import {
  decodeMarketOrderFulfilled,
  MARKET_SEAPORT_EVENTS
} from '@/marketplace/seaport.events';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

it('decodes Seaport fill evidence while rejecting another emitting contract', () => {
  const maker = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const hash = '0x' + '1'.repeat(64);
  const encoded = MARKET_SEAPORT_EVENTS.encodeEventLog(
    MARKET_SEAPORT_EVENTS.getEvent('OrderFulfilled')!,
    [
      hash,
      maker,
      MARKET_ZERO_ADDRESS,
      recipient,
      [[3, '0x33fd426905f149f8376e227d0c9d3340aad17af1', '56', '2']],
      [[0, MARKET_ZERO_ADDRESS, '0', '200', maker]]
    ]
  );
  const event = decodeMarketOrderFulfilled({
    address: MARKET_SEAPORT,
    ...encoded
  });
  expect(event).toMatchObject({
    orderHash: hash,
    offerer: maker,
    recipient,
    offer: [{ itemType: 3, tokenId: '56', amount: '2' }],
    consideration: [{ itemType: 0, amount: '200', recipient: maker }]
  });
  expect(() =>
    decodeMarketOrderFulfilled({ address: maker, ...encoded })
  ).toThrow(/deployment/);
});
