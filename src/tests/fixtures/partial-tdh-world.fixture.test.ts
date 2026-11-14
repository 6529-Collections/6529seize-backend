import {
  baseTdhFields,
  consolidatedGroupsAfter,
  editionRows,
  Group,
  groupsBefore,
  wallet,
  walletGroupsAfter
} from '@/tests/fixtures/partial-tdh-world.fixture';

/**
 * `updateBoostedTdhRates` sums each group's edition hodl rates in MySQL's
 * join order, which can differ between two runs of the same write. The
 * partial write tests compare such runs exactly, the identities sync scope
 * too, and a key whose rate moves by one ulp is recorded there. So every
 * order must give the same rate.
 */
function permutations(values: number[]): number[][] {
  if (values.length <= 1) {
    return [values];
  }
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (rest) => [value, ...rest]
    )
  );
}

/** The keys whose boosted TDH rate depends on the order of the sum. */
function orderDependentKeys(
  groups: Group[],
  hodlRates: (group: Group) => number[]
): string[] {
  return groups
    .filter((group) => {
      const boost = baseTdhFields(group, 1).boost;
      const rates = permutations(hodlRates(group)).map(
        (order) => order.reduce((sum, rate) => sum + rate, 0) * boost
      );
      return new Set(rates).size > 1;
    })
    .map((group) => group.key);
}

describe('the partial TDH world', () => {
  it.each([
    ['before the write', groupsBefore()],
    ['wallets after it', walletGroupsAfter()],
    ['groups after it', consolidatedGroupsAfter()]
  ])(
    'gives the groups %s the same boosted TDH rate in any sum order',
    (_, groups) => {
      expect(
        orderDependentKeys(groups, (group) =>
          editionRows([group]).map((row) => row.hodl_rate)
        )
      ).toEqual([]);
    }
  );

  it('would not with hodl rates over 1000: groups 8 and 11 then move by one ulp', () => {
    expect(
      orderDependentKeys(groupsBefore(), (group) =>
        Object.values(group.holdings).map((holding) => holding.tdh / 1000)
      )
    ).toEqual([wallet(8), wallet(11)]);
  });
});
