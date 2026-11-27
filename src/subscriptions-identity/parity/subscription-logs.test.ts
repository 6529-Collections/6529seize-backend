import {
  cardRowAutomaticFlag,
  parseBuildDecision,
  parseCardRowEvent,
  parseModeEvent
} from './subscription-logs';

describe('subscription log lines', () => {
  it('reads card row events for one card only', () => {
    expect(parseCardRowEvent('Auto-Subscribed to Meme #500', 500)).toEqual({
      kind: 'AUTO_SUBSCRIBED'
    });
    expect(parseCardRowEvent('Subscribed for Meme #500', 500)).toEqual({
      kind: 'SUBSCRIBED'
    });
    expect(parseCardRowEvent('Subscribed to Meme #500', 500)).toEqual({
      kind: 'MODE_SUBSCRIBED'
    });
    expect(parseCardRowEvent('Unsubscribed from Meme #500', 500)).toEqual({
      kind: 'UNSUBSCRIBED'
    });
    expect(
      parseCardRowEvent('Updated subscription count for Meme #500 to x3', 500)
    ).toEqual({ kind: 'COUNT_SET', count: 3 });
    expect(
      parseCardRowEvent(
        'Added to Final Subscription for Meme #500 on 2026-11-17',
        500,
        'Airdrop Address: 0x01 - Subscription Count: x3 - Balance: 1 ETH'
      )
    ).toEqual({ kind: 'BUILD_LISTED', count: 3 });
    expect(
      parseCardRowEvent('No Balance for Meme #500 on 2026-11-17', 500)
    ).toEqual({ kind: 'BUILD_LISTED', count: null });
    expect(parseCardRowEvent('Subscribed for Meme #5000', 500)).toBeNull();
    expect(parseCardRowEvent('Subscribed for Meme #501', 500)).toBeNull();
  });

  it('decides the automatic flag from the newest decisive event', () => {
    expect(
      cardRowAutomaticFlag([
        { kind: 'MODE_SUBSCRIBED' },
        { kind: 'AUTO_SUBSCRIBED' }
      ])
    ).toEqual({ automatic: true, ambiguous: false });
    expect(
      cardRowAutomaticFlag([
        { kind: 'COUNT_SET', count: 2 },
        { kind: 'AUTO_SUBSCRIBED' }
      ])
    ).toEqual({ automatic: false, ambiguous: false });
    expect(
      cardRowAutomaticFlag([
        { kind: 'UNSUBSCRIBED' },
        { kind: 'AUTO_SUBSCRIBED' }
      ])
    ).toEqual({ automatic: true, ambiguous: true });
    expect(cardRowAutomaticFlag([])).toEqual({
      automatic: null,
      ambiguous: false
    });
  });

  it('reads the build lines of one card and date', () => {
    expect(
      parseBuildDecision(
        {
          log: 'Added to Final Subscription for Meme #500 on 2026-11-25',
          additionalInfo:
            'Airdrop Address: 0xAB - Subscription Count: x2 - Balance: 0.13058 ETH'
        },
        500,
        '2026-11-25'
      )
    ).toEqual({
      kind: 'ADDED',
      date: '2026-11-25',
      airdropAddress: '0xab',
      count: 2,
      balance: 0.13058
    });
    expect(
      parseBuildDecision(
        {
          log: 'Insufficient Balance for Meme #500 on 2026-11-25 - Not Added to Final Subscription',
          additionalInfo: 'Balance: 0.03 ETH'
        },
        500,
        '2026-11-25'
      )
    ).toEqual({
      kind: 'INSUFFICIENT_BALANCE',
      date: '2026-11-25',
      balance: 0.03
    });
    expect(
      parseBuildDecision(
        { log: 'No Balance for Meme #500 on 2026-11-25', additionalInfo: null },
        500,
        '2026-11-25'
      )
    ).toEqual({ kind: 'NO_BALANCE', date: '2026-11-25' });
    expect(
      parseBuildDecision(
        { log: 'No Balance for Meme #500 on 2026-11-24', additionalInfo: null },
        500,
        '2026-11-25'
      )
    ).toBeNull();
  });

  it('reads mode and edition changes', () => {
    expect(parseModeEvent('Subscription Mode set to Manual')).toEqual({
      kind: 'AUTOMATIC',
      automatic: false
    });
    expect(
      parseModeEvent('Edition preference set to All eligible editions')
    ).toEqual({
      kind: 'ALL_EDITIONS',
      all: true
    });
    expect(parseModeEvent('something else')).toBeNull();
  });
});
