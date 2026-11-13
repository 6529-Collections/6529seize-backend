import { getAddress, ZeroAddress } from 'ethers';
import { readReconsolidationAction } from './reconsolidation-action';

const A = '0x3c8a67ff9d751c3cce50c9acf617959396daacd3';
const B = '0xd7342ea20a5afbf24352b5ca61e09844167914cb';

describe('readReconsolidationAction', () => {
  it.each([undefined, null, {}, { source: 'aws.events' }])(
    'leaves ordinary scheduled invocations on the indexing path: %j',
    (event) => expect(readReconsolidationAction(event)).toBeNull()
  );

  it('normalizes and deduplicates valid requested wallets', () => {
    expect(
      readReconsolidationAction({
        action: 'reconsolidate',
        wallets: [getAddress(A), A, B]
      })
    ).toEqual([A, B]);
  });

  it.each([
    'reconsolidate',
    [],
    { action: 'reset', wallets: [A] },
    { action: null, wallets: [A] },
    { wallets: [A] },
    { reconsolidation_wallets: [A] },
    { action: 'reconsolidate' },
    { action: 'reconsolidate', wallets: [] },
    { action: 'reconsolidate', wallets: A },
    { action: 'reconsolidate', wallets: [A, 'bad-address'] },
    { action: 'reconsolidate', wallets: [ZeroAddress] },
    { action: 'reconsolidate', wallets: [A, 123] },
    { action: 'reconsolidate', wallets: Array.from({ length: 101 }, () => A) }
  ])(
    'rejects malformed maintenance payloads instead of indexing: %j',
    (event) => {
      expect(() => readReconsolidationAction(event)).toThrow();
    }
  );
});
