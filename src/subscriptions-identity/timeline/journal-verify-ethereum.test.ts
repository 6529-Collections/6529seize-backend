import { Interface } from 'ethers';
import {
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTIONS_ADDRESS
} from '@/constants';
import { SubscriptionTopUp } from '@/entities/ISubscription';
import { ethereumFactsOf, EthereumReads } from './journal-verify-ethereum';

// Obviously fake wallets and hashes.
const SENDER = `0x${'1'.padStart(40, '0')}`;
const AIRDROP = `0x${'a1'.padStart(40, '0')}`;
const OPERATOR = `0x${'0e'.padStart(40, '0')}`;
const OTHER_CONTRACT = `0x${'c1'.padStart(40, '0')}`;
const TOP_UP = `0x${'ab'.padStart(64, '0')}`;
const MINT = `0x${'cd'.padStart(64, '0')}`;

const EVENTS = new Interface([
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);

function log(address: string, name: string, args: unknown[]) {
  const { topics, data } = EVENTS.encodeEventLog(name, args);
  return { address, topics, data };
}

function reads(overrides: Partial<EthereumReads> = {}): EthereumReads {
  return {
    blockOf: async (hash) => (hash.toLowerCase() === TOP_UP ? 100 : null),
    topUpsIn: async (block) =>
      block === 100
        ? [
            {
              hash: TOP_UP.toUpperCase().replace('0X', '0x'),
              block: 100,
              from_wallet: SENDER,
              amount: 0.06529,
              transaction_date: new Date(0)
            } as SubscriptionTopUp
          ]
        : [],
    logsOf: async () => null,
    ...overrides
  };
}

describe('ethereumFactsOf', () => {
  it("finds a top-up as the top-up loop reads it, by the transaction's block", async () => {
    const facts = ethereumFactsOf(reads());
    expect(await facts.topUp(TOP_UP)).toEqual({
      from: SENDER,
      to: SUBSCRIPTIONS_ADDRESS,
      valueEth: 0.06529,
      block: 100
    });
  });

  it('answers null for a transaction that is not mined, or no top-up in its block', async () => {
    expect(await ethereumFactsOf(reads()).topUp(MINT)).toBeNull();
    const empty = ethereumFactsOf(reads({ topUpsIn: async () => [] }));
    expect(await empty.topUp(TOP_UP)).toBeNull();
  });

  it('counts the tokens of one id minted to one wallet, from single and batch transfers', async () => {
    const logs = [
      log(MEMES_CONTRACT, 'TransferSingle', [
        OPERATOR,
        NULL_ADDRESS,
        AIRDROP,
        7,
        2
      ]),
      log(MEMES_CONTRACT, 'TransferBatch', [
        OPERATOR,
        NULL_ADDRESS,
        AIRDROP,
        [8, 7],
        [5, 1]
      ]),
      // Not mints of id 7 to the airdrop wallet: none of these count.
      log(MEMES_CONTRACT, 'TransferSingle', [OPERATOR, SENDER, AIRDROP, 7, 4]),
      log(MEMES_CONTRACT, 'TransferSingle', [
        OPERATOR,
        NULL_ADDRESS,
        SENDER,
        7,
        4
      ]),
      log(OTHER_CONTRACT, 'TransferSingle', [
        OPERATOR,
        NULL_ADDRESS,
        AIRDROP,
        7,
        4
      ]),
      log(MEMES_CONTRACT, 'Transfer', [NULL_ADDRESS, AIRDROP, 9])
    ];
    const facts = ethereumFactsOf(
      reads({ logsOf: async (hash) => (hash === MINT ? logs : null) })
    );
    expect(
      await facts.mintedTo(MINT, MEMES_CONTRACT.toLowerCase(), 7, AIRDROP)
    ).toBe(3);
    expect(await facts.mintedTo(MINT, MEMES_CONTRACT, 8, AIRDROP)).toBe(5);
    expect(await facts.mintedTo(TOP_UP, MEMES_CONTRACT, 7, AIRDROP)).toBe(0);
  });
});
