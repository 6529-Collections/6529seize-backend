import {
  attributeByAddress,
  identitiesOfKey,
  mapCurrentKeys,
  openingKeys
} from './opening-attribution';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const principal = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const P1 = principal(1);
const P2 = principal(2);
const W = [0, 1, 2, 3, 4, 5].map((n) => wallet(n + 1));

// W0 and W1 are one identity, W2 another; W3 is bound to P1 too; W4, W5 unbound.
const byWallet = new Map([
  [W[0], P1],
  [W[1], P1],
  [W[3], P1],
  [W[2], P2]
]);

describe('opening attribution', () => {
  it('names the identities of a key, an unbound wallet being its own', () => {
    expect(identitiesOfKey(`${W[0]}-${W[1]}`, byWallet)).toEqual([P1]);
    expect(identitiesOfKey(`${W[0]}-${W[2]}`, byWallet)).toEqual([P1, P2]);
    expect(identitiesOfKey(W[4].toUpperCase(), byWallet)).toEqual([W[4]]);
  });

  it('maps keys to identities, names identities several keys share, and blocks splits', () => {
    const map = mapCurrentKeys(
      [`${W[0]}-${W[1]}`, W[3], `${W[2]}-${W[4]}`, W[5]],
      byWallet
    );
    expect(Array.from(map.identityOf.entries())).toEqual([
      [`${W[0]}-${W[1]}`, P1],
      [W[3], P1],
      [W[5], W[5]]
    ]);
    expect(Array.from(map.shared.entries())).toEqual([
      [P1, [`${W[0]}-${W[1]}`, W[3]]]
    ]);
    expect(map.blocked).toEqual([
      {
        consolidationKey: `${W[2]}-${W[4]}`,
        reason: 'SPANS_IDENTITIES',
        identities: [P2, W[4]].sort()
      }
    ]);
  });

  it('gives a history row of a split key to the identity of its airdrop address', () => {
    const key = `${W[0]}-${W[2]}`;
    expect(attributeByAddress('t', key, W[2], byWallet)).toEqual({
      identityKey: P2,
      note: {
        table: 't',
        consolidationKey: key,
        identityKey: P2,
        rule: 'AIRDROP_ADDRESS'
      }
    });
    // A delegated airdrop address outside the key: the first identity.
    expect(attributeByAddress('t', key, W[5], byWallet).note?.rule).toBe(
      'FIRST_IDENTITY'
    );
    expect(attributeByAddress('t', `${W[0]}-${W[1]}`, W[5], byWallet)).toEqual({
      identityKey: P1,
      note: null
    });
  });

  it('lists every key once, sorted, with where its state went', () => {
    const current = mapCurrentKeys([W[5]], byWallet);
    const identityOf = (key: string) =>
      current.identityOf.get(key) ?? identitiesOfKey(key, byWallet)[0];
    expect(
      openingKeys([W[5], `${W[0]}-${W[2]}`, W[5]], identityOf, byWallet)
    ).toEqual([
      {
        consolidationKey: `${W[0]}-${W[2]}`,
        identityKey: P1,
        identities: [P1, P2]
      },
      { consolidationKey: W[5], identityKey: W[5], identities: [W[5]] }
    ]);
  });
});
