import * as fc from 'fast-check';
import { CONSOLIDATION_FOURTH_WALLET_ACTIVATION_TIMESTAMP } from '@/constants';
import { ConsolidationLink, ConsolidationTools } from './consolidation-tools';

const ACTIVATION = CONSOLIDATION_FOURTH_WALLET_ACTIVATION_TIMESTAMP;
const BEFORE = ACTIVATION - 86_400;
const AFTER = ACTIVATION + 3_600;

const tools = new ConsolidationTools();

function legacy(wallet1: string, wallet2: string, block: number) {
  return {
    wallet1,
    wallet2,
    block,
    wallet1_registered_at: null,
    wallet2_registered_at: null
  };
}

function registered(
  wallet1: string,
  wallet2: string,
  block: number,
  wallet1RegisteredAt: number | null,
  wallet2RegisteredAt: number | null = wallet1RegisteredAt
): ConsolidationLink {
  return {
    wallet1,
    wallet2,
    block,
    wallet1_registered_at: wallet1RegisteredAt,
    wallet2_registered_at: wallet2RegisteredAt
  };
}

function mesh(
  wallets: string[],
  block: number,
  registeredAt: number | null
): ConsolidationLink[] {
  const links: ConsolidationLink[] = [];
  wallets.forEach((wallet1, i) =>
    wallets
      .slice(i + 1)
      .forEach((wallet2) =>
        links.push(registered(wallet1, wallet2, block, registeredAt))
      )
  );
  return links;
}

function groups(links: ConsolidationLink[]): string[] {
  return tools
    .extractConsolidations(links.map((link) => ({ ...link })))
    .map((cluster) => tools.buildConsolidationKey(cluster))
    .sort((a, b) => a.localeCompare(b));
}

const LEGACY_ABC = [
  legacy('a', 'b', 1),
  legacy('a', 'c', 2),
  legacy('b', 'c', 3)
];

// The grouping as it was before four-wallet consolidations, kept verbatim
// apart from types so legacy inputs can be compared against it.
function previousExtractConsolidations(
  consolidations: { wallet1: string; wallet2: string; block: number }[]
): string[][] {
  consolidations.sort((a, b) => b.block - a.block);
  const usedWallets = new Set<string>();
  const clusters: string[][] = [];
  const consolidationSet = new Set<string>();
  for (const c of consolidations) {
    consolidationSet.add(tools.buildConsolidationKey([c.wallet1, c.wallet2]));
  }
  const queue = [...consolidations];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const { wallet1, wallet2 } = current;
    if (usedWallets.has(wallet1) || usedWallets.has(wallet2)) {
      continue;
    }
    const cluster = new Set<string>([wallet1, wallet2]);
    let changed = true;
    while (changed && cluster.size < 3) {
      changed = false;
      for (let i = 0; i < queue.length; i++) {
        const { wallet1: w1, wallet2: w2 } = queue[i];
        let newWallet: string | null = null;
        if (cluster.has(w1) && !cluster.has(w2) && !usedWallets.has(w2)) {
          newWallet = w2;
        } else if (
          cluster.has(w2) &&
          !cluster.has(w1) &&
          !usedWallets.has(w1)
        ) {
          newWallet = w1;
        }
        if (newWallet) {
          const safeWallet = newWallet;
          const allConnectionsExist = Array.from(cluster).every((existing) =>
            consolidationSet.has(
              tools.buildConsolidationKey([existing, safeWallet])
            )
          );
          if (allConnectionsExist) {
            cluster.add(safeWallet);
            queue.splice(i, 1);
            changed = true;
            break;
          }
        }
      }
    }
    const clusterArray = Array.from(cluster);
    for (const w of clusterArray) {
      usedWallets.add(w);
    }
    clusters.push(clusterArray);
  }
  const allWallets = new Set<string>();
  for (const c of consolidations) {
    allWallets.add(c.wallet1);
    allWallets.add(c.wallet2);
  }
  for (const w of Array.from(allWallets)) {
    if (!usedWallets.has(w)) {
      clusters.push([w]);
      usedWallets.add(w);
    }
  }
  return clusters;
}

const WALLETS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

const linkGraph = (timestamp: fc.Arbitrary<number | null>) =>
  fc
    .uniqueArray(
      fc
        .tuple(
          fc.constantFrom(...WALLETS),
          fc.constantFrom(...WALLETS),
          timestamp,
          timestamp
        )
        .filter(([w1, w2]) => w1 !== w2),
      {
        selector: ([w1, w2]) => tools.buildConsolidationKey([w1, w2]),
        maxLength: 21
      }
    )
    .chain((pairs) =>
      fc
        .shuffledSubarray(
          pairs.map((_, index) => index + 1),
          { minLength: pairs.length, maxLength: pairs.length }
        )
        .map((blocks) =>
          pairs.map(([w1, w2, ts1, ts2], index) =>
            registered(w1, w2, blocks[index], ts1, ts2)
          )
        )
    );

// Few distinct blocks, so many links share a block and the tie-break matters.
const tiedLinkGraph = fc
  .uniqueArray(
    fc
      .tuple(
        fc.constantFrom(...WALLETS),
        fc.constantFrom(...WALLETS),
        fc.integer({ min: 1, max: 3 }),
        fc.option(fc.constantFrom(BEFORE, AFTER), { nil: null })
      )
      .filter(([w1, w2]) => w1 !== w2),
    {
      selector: ([w1, w2]) => tools.buildConsolidationKey([w1, w2]),
      maxLength: 21
    }
  )
  .map((pairs) =>
    pairs.map(([w1, w2, block, ts]) => registered(w1, w2, block, ts))
  );

describe('ConsolidationTools.extractConsolidations', () => {
  it('keeps an existing three-wallet consolidation', () => {
    expect(groups(LEGACY_ABC)).toEqual(['a-b-c']);
  });

  it('adds a fourth wallet whose links were all registered after activation', () => {
    expect(
      groups([
        ...LEGACY_ABC,
        registered('a', 'd', 10, AFTER),
        registered('b', 'd', 10, AFTER),
        registered('c', 'd', 10, AFTER)
      ])
    ).toEqual(['a-b-c-d']);
  });

  it('does not form a four-wallet group from links registered before activation', () => {
    expect(
      groups([
        ...LEGACY_ABC,
        legacy('a', 'd', 4),
        legacy('b', 'd', 5),
        legacy('c', 'd', 6)
      ])
    ).toEqual(['a', 'b-c-d']);
  });

  it('requires both directions of each fourth-wallet link to be after activation', () => {
    // a, b and c registered towards d long ago; only d signed after activation.
    expect(
      groups([
        ...LEGACY_ABC,
        registered('a', 'd', 10, BEFORE, AFTER),
        registered('b', 'd', 10, BEFORE, AFTER),
        registered('c', 'd', 10, BEFORE, AFTER)
      ])
    ).toEqual(['a-b-d', 'c']);
  });

  it('lets an older group take a fourth wallet after its links are re-registered', () => {
    expect(
      groups([
        ...LEGACY_ABC,
        registered('a', 'd', 4, AFTER),
        registered('b', 'd', 5, AFTER),
        registered('c', 'd', 6, AFTER)
      ])
    ).toEqual(['a-b-c-d']);
  });

  it('counts a registration at the activation time but not one second before', () => {
    const fourth = (registeredAt: number) => [
      ...LEGACY_ABC,
      registered('a', 'd', 10, ACTIVATION),
      registered('b', 'd', 10, ACTIVATION),
      registered('c', 'd', 10, registeredAt)
    ];
    expect(groups(fourth(ACTIVATION))).toEqual(['a-b-c-d']);
    // Without the gate d's newer links still win, so c is left out, as today.
    expect(groups(fourth(ACTIVATION - 1))).toEqual(['a-b-d', 'c']);
  });

  it('forms a new four-wallet group when every link is registered after activation', () => {
    expect(groups(mesh(['a', 'b', 'c', 'd'], 10, AFTER))).toEqual(['a-b-c-d']);
  });

  it('caps a fully linked group at four wallets', () => {
    expect(groups(mesh(['a', 'b', 'c', 'd', 'e'], 10, AFTER))).toEqual([
      'a-b-c-d',
      'e'
    ]);
  });

  it('still treats a single new link as moving that wallet', () => {
    // Linking only a and d is how a wallet leaves to pair elsewhere.
    expect(groups([...LEGACY_ABC, registered('a', 'd', 10, AFTER)])).toEqual([
      'a-d',
      'b-c'
    ]);
  });

  it('groups links confirmed in the same block the same way in any input order', () => {
    const links = [
      registered('a', 'b', 7, AFTER),
      registered('c', 'd', 7, AFTER),
      registered('a', 'c', 7, AFTER),
      registered('b', 'd', 7, AFTER)
    ];
    const expected = groups(links);
    fc.assert(
      fc.property(fc.shuffledSubarray(links, { minLength: 4 }), (shuffled) => {
        expect(groups(shuffled)).toEqual(expected);
      })
    );
  });

  it('groups pre-activation links exactly as the previous algorithm did', () => {
    fc.assert(
      fc.property(linkGraph(fc.constant(null)), (links) => {
        const previous = previousExtractConsolidations(
          links.map((link) => ({ ...link }))
        )
          .map((cluster) => tools.buildConsolidationKey(cluster))
          .sort((a, b) => a.localeCompare(b));
        expect(groups(links)).toEqual(previous);
      }),
      { numRuns: 500 }
    );
  });

  it('only returns fully linked groups of up to four that pass the gate', () => {
    const timestamp = fc.option(fc.constantFrom(BEFORE, ACTIVATION, AFTER), {
      nil: null
    });
    fc.assert(
      fc.property(linkGraph(timestamp), (links) => {
        const byKey = new Map(
          links.map((link) => [
            tools.buildConsolidationKey([link.wallet1, link.wallet2]),
            link
          ])
        );
        const clusters = tools.extractConsolidations(
          links.map((link) => ({ ...link }))
        );
        const seen = clusters.flat();
        expect(new Set(seen).size).toBe(seen.length);
        for (const cluster of clusters) {
          expect(cluster.length).toBeLessThanOrEqual(4);
          cluster.forEach((w1, i) =>
            cluster.slice(i + 1).forEach((w2) => {
              expect(byKey.has(tools.buildConsolidationKey([w1, w2]))).toBe(
                true
              );
            })
          );
          if (cluster.length === 4) {
            const hasPostActivationMember = cluster.some((candidate) =>
              cluster.every(
                (other) =>
                  other === candidate ||
                  tools.isPostActivationLink(
                    byKey.get(tools.buildConsolidationKey([candidate, other]))
                  )
              )
            );
            expect(hasPostActivationMember).toBe(true);
          }
        }
      }),
      { numRuns: 500 }
    );
  });

  it('does not depend on the order rows arrive in', () => {
    fc.assert(
      fc.property(
        tiedLinkGraph.chain((links) =>
          fc.tuple(
            fc.constant(links),
            fc.shuffledSubarray(links, {
              minLength: links.length,
              maxLength: links.length
            })
          )
        ),
        ([links, shuffled]) => {
          expect(groups(shuffled)).toEqual(groups(links));
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('ConsolidationTools.isPostActivationLink', () => {
  it('needs both directions registered at or after activation', () => {
    expect(tools.isPostActivationLink(registered('a', 'b', 1, AFTER))).toBe(
      true
    );
    expect(
      tools.isPostActivationLink(registered('a', 'b', 1, AFTER, BEFORE))
    ).toBe(false);
    expect(tools.isPostActivationLink(legacy('a', 'b', 1))).toBe(false);
    expect(tools.isPostActivationLink(undefined)).toBe(false);
  });

  it('accepts timestamps returned as strings by the database driver', () => {
    expect(
      tools.isPostActivationLink({
        ...registered('a', 'b', 1, null),
        wallet1_registered_at: `${AFTER}` as unknown as number,
        wallet2_registered_at: `${ACTIVATION}` as unknown as number
      })
    ).toBe(true);
  });
});
