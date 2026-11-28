import { createHash } from 'node:crypto';
import { computeAddress } from 'ethers';
import {
  ALL_WORLD_ACTORS,
  PROBE_WALLETS,
  SUBS_WIDE_LABELS,
  WAVES_PERSON_LABELS,
  WORLD_ACTOR_LABELS,
  wavesPersonKey,
  wavesPersonWallet,
  worldActorIdentity,
  worldActorKey,
  worldActorProfileId,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
import { compareCodeUnits } from '@/rebuild/code-units';

const sha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The wallets derived from the actors' labels by the key rule in
 * probe-fixture.ts: the SHA-256 of JSON.stringify of the [label, address]
 * pairs, in label order. A hash, so this test holds no address. Once a
 * gateway recording carries the actors, the pin moves to it.
 */
const ACTOR_WALLETS_SHA256 =
  '353104b27f6906fe7fb0460174bee851a60ee87c8d6da48b5942a3a28fc58aa6';
/**
 * The waves people as the identity world file of the gateway recording the
 * check replays holds them: the SHA-256 of JSON.stringify of the [person,
 * wallets] pairs, people and each person's wallets in code-unit order.
 * devnet_p4 and devnet_p8 each hold a second wallet, labelled with _b; the
 * file doesn't say which of the two is the _b one.
 */
const RECORDED_PEOPLE_WALLETS_SHA256 =
  '4dbcd40a7d1aa1bb3f8523b25938eb0521a74ee80089c6bf4293e2cc98c76d33';

describe("the world's actors", () => {
  it('derive their wallets from their labels', () => {
    expect(
      sha256(
        WORLD_ACTOR_LABELS.map((label) => [label, worldActorWallet(label)])
      )
    ).toBe(ACTOR_WALLETS_SHA256);
  });

  it('give each label its own key and the key its wallet', () => {
    const wallets = [
      ...WORLD_ACTOR_LABELS.map((label) => {
        expect(worldActorKey(label)).toMatch(/^0x[0-9a-f]{64}$/);
        expect(computeAddress(worldActorKey(label)).toLowerCase()).toBe(
          worldActorWallet(label)
        );
        return worldActorWallet(label);
      }),
      ...WAVES_PERSON_LABELS.map((label) => {
        expect(computeAddress(wavesPersonKey(label)).toLowerCase()).toBe(
          wavesPersonWallet(label)
        );
        return wavesPersonWallet(label);
      })
    ];
    for (const wallet of wallets) expect(wallet).toMatch(/^0x[0-9a-f]{40}$/);
    expect(new Set([...wallets, ...PROBE_WALLETS]).size).toBe(
      wallets.length + PROBE_WALLETS.length
    );
  });

  it('refuse a label outside their family', () => {
    expect(() => worldActorKey('records' as never)).toThrow(
      'records is not one of the world'
    );
    expect(() => wavesPersonKey('devnet_p5' as never)).toThrow(
      'devnet_p5 is not one of the world'
    );
    expect(() => worldActorKey('devnet_p0' as never)).toThrow();
  });

  it("hold the identity world's ids, handles and wallets", () => {
    expect(
      ALL_WORLD_ACTORS.map((actor) => [actor, worldActorProfileId(actor)])
    ).toEqual([
      ['probe-1', '00000000-0000-4000-8000-000000000101'],
      ['probe-2', '00000000-0000-4000-8000-000000000102'],
      ['records-service', '00000000-0000-4000-8000-0000000001a1'],
      ['live-owner', '00000000-0000-4000-8000-0000000000b1'],
      ['subs-wide', '00000000-0000-4000-8000-0000000001d0'],
      ['dm-e2ee-a', '00000000-0000-4000-8000-0000000001e1'],
      ['dm-e2ee-b', '00000000-0000-4000-8000-0000000001e2'],
      ['dm-e2ee-c', '00000000-0000-4000-8000-0000000001e3']
    ]);
    for (const actor of ALL_WORLD_ACTORS) {
      // 6529.io's handle rule.
      expect(worldActorIdentity(actor).handle).toMatch(/^\w{3,15}$/);
    }
    expect(worldActorIdentity('probe-1').wallets).toEqual([PROBE_WALLETS[0]]);
    expect(worldActorIdentity('dm-e2ee-b').wallets).toEqual([
      worldActorWallet('dm-e2ee-b')
    ]);
  });

  it('give subs-wide one identity of 15 wallets, its lowest the primary', () => {
    expect(SUBS_WIDE_LABELS).toEqual(
      Array.from(
        { length: 15 },
        (_, i) => `subs-wide-${String(i + 1).padStart(2, '0')}`
      )
    );
    const { wallets, primary } = worldActorIdentity('subs-wide');
    const labelled = SUBS_WIDE_LABELS.map((label) => worldActorWallet(label));
    expect(new Set(wallets)).toEqual(new Set(labelled));
    // In order, as the identity import lists them: the lowest is the
    // primary address, whichever label it has.
    expect(wallets.every((w, i) => i === 0 || wallets[i - 1] < w)).toBe(true);
    expect(primary).toBe(wallets[0]);
    // Its consolidation key: 15 addresses and 14 dashes.
    expect(wallets.join('-')).toHaveLength(644);
  });
});

describe('the waves people', () => {
  it('hold the wallets the gateway recording holds for them', () => {
    const people = new Map<string, string[]>();
    for (const label of WAVES_PERSON_LABELS) {
      const person = label.replace(/_b$/, '');
      people.set(person, [
        ...(people.get(person) ?? []),
        wavesPersonWallet(label)
      ]);
    }
    expect(
      sha256(
        Array.from(people.entries())
          .sort(([a], [b]) => compareCodeUnits(a, b))
          .map(([person, wallets]) => [
            person,
            [...wallets].sort(compareCodeUnits)
          ])
      )
    ).toBe(RECORDED_PEOPLE_WALLETS_SHA256);
  });
});
