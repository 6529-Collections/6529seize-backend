import { createHash } from 'node:crypto';
import { devnetWallet, IDENTITY_WORLD_WALLETS } from './world-ids';

/** The devnet wallets world-ids.ts derives from their labels. */
const DEVNET = [
  'pairA',
  'pairB',
  'founder',
  'delegate',
  'siteFounder',
  'siteTdh'
] as const;

/**
 * The capture the world was checked against (v4): the SHA-256 of
 * JSON.stringify of the [name, address] pairs above, in that order, with
 * each address as its identity world file (identity-world.json) lists it
 * under `wallets`. A hash, so this test holds no address either (the
 * world's placeholders file is built from these wallets at run time); a
 * capture whose harness keys its wallets differently fails here.
 */
const V4_WALLETS_SHA256 =
  '91a5953c3e4269aab974fa96d5d087d95831ad5ca86bd5472d62cd5bb8e188c5';

describe('the devnet wallets', () => {
  it("are the ones the capture's identity world file lists", () => {
    const pairs = DEVNET.map((name) => [name, IDENTITY_WORLD_WALLETS[name]]);
    expect(
      createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
    ).toBe(V4_WALLETS_SHA256);
  });

  it('are lowercase addresses, one per label, the pair lower first', () => {
    const wallets = DEVNET.map((name) => IDENTITY_WORLD_WALLETS[name]);
    for (const address of wallets) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(new Set(wallets).size).toBe(DEVNET.length);
    expect(IDENTITY_WORLD_WALLETS.pairA < IDENTITY_WORLD_WALLETS.pairB).toBe(
      true
    );
    expect(devnetWallet('IF')).toBe(IDENTITY_WORLD_WALLETS.founder);
  });
});
