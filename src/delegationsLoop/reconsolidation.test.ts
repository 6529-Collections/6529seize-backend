import { retrieveConsolidationsForWallets } from '@/db';
import { ConsolidationEvent, EventType } from '@/entities/IDelegation';
import { ConsolidatedTDH } from '@/entities/ITDH';
import { getAffectedWallets } from './reconsolidation';

jest.mock('@/db', () => ({
  retrieveConsolidationsForWallets: jest.fn()
}));

const mockedRetrieveConsolidationsForWallets =
  retrieveConsolidationsForWallets as jest.MockedFunction<
    typeof retrieveConsolidationsForWallets
  >;

const A = '0x3c8a67ff9d751c3cce50c9acf617959396daacd3';
const B = '0xd7342ea20a5afbf24352b5ca61e09844167914cb';
const C = '0x145717c6af8f36060344f3725e6e5911ca4e0921';

function currentTdhRow(wallets: string[]): ConsolidatedTDH {
  return {
    consolidation_key: wallets.join('-'),
    wallets
  } as ConsolidatedTDH;
}

describe('getAffectedWallets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes a restored cluster member missing from the old derived row', async () => {
    mockedRetrieveConsolidationsForWallets.mockResolvedValue({
      [A]: `${A}-${B}`,
      [C]: C
    });

    const events: ConsolidationEvent[] = [
      {
        block: 3,
        type: EventType.REVOKE,
        wallet1: C.toUpperCase(),
        wallet2: A.toUpperCase()
      }
    ];
    const affected = await getAffectedWallets(events, [
      currentTdhRow([A, C]),
      currentTdhRow([B])
    ]);

    expect(Array.from(affected).sort((a, b) => a.localeCompare(b))).toEqual(
      [A, B, C].sort((a, b) => a.localeCompare(b))
    );
    expect(mockedRetrieveConsolidationsForWallets).toHaveBeenCalledWith([C, A]);
  });

  it('normalizes registration and revocation directions and handles multiple events together', async () => {
    const D = '0x000000000000000000000000000000000000000d';
    const E = '0x000000000000000000000000000000000000000e';
    mockedRetrieveConsolidationsForWallets.mockImplementation(async (wallets) =>
      Object.fromEntries(
        wallets.map((wallet) => {
          if (wallet === A || wallet === B) {
            return [wallet, `${A}-${B}`];
          }
          if (wallet === D || wallet === E) {
            return [wallet, `${D}-${E}`];
          }
          return [wallet, wallet];
        })
      )
    );

    const affected = await getAffectedWallets(
      [
        {
          block: 4,
          type: EventType.REGISTER,
          wallet1: B.toUpperCase(),
          wallet2: A
        },
        {
          block: 5,
          type: EventType.REVOKE,
          wallet1: D.toUpperCase(),
          wallet2: E
        }
      ],
      []
    );

    expect(affected).toEqual(new Set([A, B, D, E]));
  });

  it('bounds confirmed-cluster lookups to batches of 100 wallets', async () => {
    mockedRetrieveConsolidationsForWallets.mockImplementation(async (wallets) =>
      Object.fromEntries(wallets.map((wallet) => [wallet, wallet]))
    );
    const events: ConsolidationEvent[] = Array.from(
      { length: 51 },
      (_, index) => ({
        block: index,
        type: EventType.REGISTER,
        wallet1: `wallet-${index}-a`,
        wallet2: `wallet-${index}-b`
      })
    );

    await getAffectedWallets(events, []);

    expect(mockedRetrieveConsolidationsForWallets).toHaveBeenCalledTimes(2);
    mockedRetrieveConsolidationsForWallets.mock.calls.forEach(([wallets]) => {
      expect(wallets.length).toBeLessThanOrEqual(100);
    });
  });
});
