import { getAddress } from 'ethers';
import fc from 'fast-check';
import { DELEGATIONS_IFACE } from '@/abis/delegations';
import { NEVER_DATE } from '@/constants';
import {
  createDelegationStateReader,
  DelegationStateEntry,
  DelegationStateQuery,
  RegistrationLogRef,
  resolveRegistrationExpiries,
  RevocationLogRef
} from '@/delegation-registration-expiry';

const STATE_VIEW = 'retrieveDelegationAddressesTokensIDsandExpiredDates';
const CONTRACT = '0x2202CB9c00487e7e8EF21e6d8E914B32e709f43d';
const DELEGATOR = '0x1000000000000000000000000000000000000001';
const COLLECTION = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
const DELEGATE_A = getAddress('0xa00000000000000000000000000000000000000a');
const DELEGATE_B = getAddress('0xb00000000000000000000000000000000000000b');

function registration(
  overrides: Partial<RegistrationLogRef> = {}
): RegistrationLogRef {
  return {
    block: 100,
    logIndex: 0,
    delegator: DELEGATOR,
    collection: COLLECTION,
    delegate: DELEGATE_A,
    useCase: 2,
    allTokens: true,
    tokenId: 0,
    ...overrides
  };
}

function revocation(
  overrides: Partial<RevocationLogRef> = {}
): RevocationLogRef {
  return {
    block: 100,
    logIndex: 0,
    delegator: DELEGATOR,
    collection: COLLECTION,
    delegate: DELEGATE_A,
    useCase: 2,
    ...overrides
  };
}

function entry(
  delegate: string,
  expiry: number | bigint,
  allTokens = true,
  tokenId: number | bigint = 0
): DelegationStateEntry {
  return {
    delegate,
    expiry: BigInt(expiry),
    allTokens,
    tokenId: BigInt(tokenId)
  };
}

describe('createDelegationStateReader', () => {
  it('reads the stored registrations at the given block', async () => {
    const call = jest.fn(async (to: string, data: string, blockTag: number) =>
      DELEGATIONS_IFACE.encodeFunctionResult(STATE_VIEW, [
        [DELEGATE_A, DELEGATE_B],
        [BigInt(1700000000), BigInt(1800000000)],
        [true, false],
        [BigInt(0), BigInt(42)]
      ])
    );
    const read = createDelegationStateReader(call, CONTRACT);

    const state = await read({
      block: 123,
      delegator: DELEGATOR,
      collection: COLLECTION,
      useCase: 2
    });

    expect(call).toHaveBeenCalledTimes(1);
    const [to, data, blockTag] = call.mock.calls[0];
    expect(to).toBe(CONTRACT);
    expect(blockTag).toBe(123);
    const args = DELEGATIONS_IFACE.decodeFunctionData(STATE_VIEW, data);
    expect(args[0]).toBe(DELEGATOR);
    expect(args[1]).toBe(COLLECTION);
    expect(args[2]).toBe(BigInt(2));
    expect(state).toEqual([
      entry(DELEGATE_A, BigInt(1700000000), true, BigInt(0)),
      entry(DELEGATE_B, BigInt(1800000000), false, BigInt(42))
    ]);
  });

  it('throws when the call fails', async () => {
    const read = createDelegationStateReader(
      jest.fn().mockRejectedValue(new Error('rpc down')),
      CONTRACT
    );
    await expect(
      read({
        block: 1,
        delegator: DELEGATOR,
        collection: COLLECTION,
        useCase: 2
      })
    ).rejects.toThrow('rpc down');
  });

  it('throws when the result cannot be decoded', async () => {
    const read = createDelegationStateReader(
      jest.fn().mockResolvedValue('0x'),
      CONTRACT
    );
    await expect(
      read({
        block: 1,
        delegator: DELEGATOR,
        collection: COLLECTION,
        useCase: 2
      })
    ).rejects.toThrow();
  });
});

describe('resolveRegistrationExpiries', () => {
  it('reads nothing when there are no registrations', async () => {
    const readState = jest.fn();
    await expect(
      resolveRegistrationExpiries([], [], readState)
    ).resolves.toEqual([]);
    expect(readState).not.toHaveBeenCalled();
  });

  it('matches registrations in one block to the latest stored entries in log order', async () => {
    const readState = jest.fn(async () => [
      entry(DELEGATE_A, 1000, false, 7),
      entry(DELEGATE_B, 5555),
      entry(DELEGATE_A, 2000, false, 8),
      entry(DELEGATE_A, 3000, true, 0)
    ]);

    const expiries = await resolveRegistrationExpiries(
      [
        registration({ logIndex: 9, allTokens: true, tokenId: 0 }),
        registration({ logIndex: 4, allTokens: false, tokenId: 8 }),
        registration({ logIndex: 6, delegate: DELEGATE_B })
      ],
      [],
      readState
    );

    expect(expiries).toEqual([3000, 2000, 5555]);
    expect(readState).toHaveBeenCalledTimes(1);
    expect(readState).toHaveBeenCalledWith({
      block: 100,
      delegator: DELEGATOR,
      collection: COLLECTION,
      useCase: 2
    });
  });

  it('matches delegate addresses case-insensitively', async () => {
    const expiries = await resolveRegistrationExpiries(
      [registration({ delegate: DELEGATE_A.toLowerCase() })],
      [],
      async () => [entry(DELEGATE_A, 1234)]
    );
    expect(expiries).toEqual([1234]);
  });

  it('reads each block, delegator, collection and use case separately', async () => {
    const queries: DelegationStateQuery[] = [];
    const readState = jest.fn(async (query: DelegationStateQuery) => {
      queries.push(query);
      return [entry(DELEGATE_A, query.block * 10 + query.useCase)];
    });

    const expiries = await resolveRegistrationExpiries(
      [
        registration({ block: 100, useCase: 2 }),
        registration({ block: 100, useCase: 3 }),
        registration({ block: 101, useCase: 2 })
      ],
      [],
      readState
    );

    expect(expiries).toEqual([1002, 1003, 1012]);
    expect(queries).toHaveLength(3);
  });

  it('returns null without reading for a registration revoked later in the same block', async () => {
    const readState = jest.fn();

    const expiries = await resolveRegistrationExpiries(
      [registration({ logIndex: 1 })],
      [revocation({ logIndex: 2 })],
      readState
    );

    expect(expiries).toEqual([null]);
    expect(readState).not.toHaveBeenCalled();
  });

  it('keeps a registration made after a revocation in the same block', async () => {
    const expiries = await resolveRegistrationExpiries(
      [registration({ logIndex: 3 })],
      [revocation({ logIndex: 2 }), revocation({ block: 99, logIndex: 9 })],
      async () => [entry(DELEGATE_A, 4321)]
    );
    expect(expiries).toEqual([4321]);
  });

  it('throws when the contract holds fewer registrations than the logs', async () => {
    await expect(
      resolveRegistrationExpiries(
        [registration({ logIndex: 1 }), registration({ logIndex: 2 })],
        [],
        async () => [entry(DELEGATE_A, 1)]
      )
    ).rejects.toThrow('Expected 2 stored registration(s)');
  });

  it('throws when the stored scope does not match the log', async () => {
    await expect(
      resolveRegistrationExpiries(
        [registration({ allTokens: false, tokenId: 5 })],
        [],
        async () => [entry(DELEGATE_A, 1, false, 6)]
      )
    ).rejects.toThrow('does not match');
    await expect(
      resolveRegistrationExpiries(
        [registration({ allTokens: true })],
        [],
        async () => [entry(DELEGATE_A, 1, false, 0)]
      )
    ).rejects.toThrow('does not match');
  });

  it('propagates a failed read', async () => {
    await expect(
      resolveRegistrationExpiries([registration()], [], async () => {
        throw new Error('archive read failed');
      })
    ).rejects.toThrow('archive read failed');
  });

  it('treats expiry dates beyond the safe integer range as never expiring', async () => {
    const expiries = await resolveRegistrationExpiries(
      [registration()],
      [],
      async () => [entry(DELEGATE_A, BigInt('0x' + 'f'.repeat(64)))]
    );
    expect(expiries).toEqual([NEVER_DATE]);
  });

  it('runs at most five state reads at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const readState = async (query: DelegationStateQuery) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return [entry(DELEGATE_A, query.block)];
    };
    const registrations = Array.from({ length: 12 }, (_, i) =>
      registration({ block: 200 + i })
    );

    const expiries = await resolveRegistrationExpiries(
      registrations,
      [],
      readState
    );

    expect(expiries).toEqual(registrations.map((r) => r.block));
    expect(maxInFlight).toBe(5);
  });

  it('agrees with a simulation of the contract for any sequence of registrations and revocations', async () => {
    const delegates = [DELEGATE_A, DELEGATE_B];
    const operation = fc.oneof(
      fc.record({
        kind: fc.constant('register' as const),
        block: fc.integer({ min: 1, max: 3 }),
        delegate: fc.constantFrom(...delegates),
        allTokens: fc.boolean(),
        tokenId: fc.integer({ min: 0, max: 3 }),
        expiry: fc.integer({ min: 1, max: 2_000_000_000 })
      }),
      fc.record({
        kind: fc.constant('revoke' as const),
        block: fc.integer({ min: 1, max: 3 }),
        delegate: fc.constantFrom(...delegates)
      })
    );

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { maxLength: 20 }), async (ops) => {
        // Logs come in block order; within a block, in array order.
        const ordered = ops
          .map((op, i) => ({ ...op, logIndex: i }))
          .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

        // Simulate the contract: a registration appends to the delegate's
        // list, a revocation deletes it. Snapshot the state after each block.
        const stored = new Map<string, DelegationStateEntry[]>();
        const stateAtBlock = new Map<number, DelegationStateEntry[]>();
        const registrations: RegistrationLogRef[] = [];
        const revocations: RevocationLogRef[] = [];
        const expected: (number | null)[] = [];
        for (const op of ordered) {
          if (op.kind === 'register') {
            const list = stored.get(op.delegate) ?? [];
            list.push(
              entry(
                op.delegate,
                op.expiry,
                op.allTokens,
                op.allTokens ? 0 : op.tokenId
              )
            );
            stored.set(op.delegate, list);
            registrations.push(
              registration({
                block: op.block,
                logIndex: op.logIndex,
                delegate: op.delegate,
                allTokens: op.allTokens,
                tokenId: op.tokenId
              })
            );
            const revokedLater = ordered.some(
              (other) =>
                other.kind === 'revoke' &&
                other.block === op.block &&
                other.delegate === op.delegate &&
                other.logIndex > op.logIndex
            );
            expected.push(revokedLater ? null : op.expiry);
          } else {
            stored.delete(op.delegate);
            revocations.push(
              revocation({
                block: op.block,
                logIndex: op.logIndex,
                delegate: op.delegate
              })
            );
          }
          stateAtBlock.set(
            op.block,
            ([] as DelegationStateEntry[]).concat(
              ...Array.from(stored.values())
            )
          );
        }

        const expiries = await resolveRegistrationExpiries(
          registrations,
          revocations,
          async (query) => stateAtBlock.get(query.block) ?? []
        );
        expect(expiries).toEqual(expected);
      })
    );
  });
});
