import { concat, getAddress, keccak256, toBeHex, zeroPadValue } from 'ethers';
import fc from 'fast-check';
import { DELEGATIONS_IFACE } from '@/abis/delegations';
import { NEVER_DATE } from '@/constants';
import {
  createDelegationStateReader,
  delegationGlobalHash,
  DelegationStateEntry,
  DelegationStateQuery,
  DelegationStateReader,
  RegistrationLogRef,
  resolveRegistrationExpiries,
  RevocationLogRef
} from '@/delegation-registration-expiry';

const CONTRACT = '0x2202CB9c00487e7e8EF21e6d8E914B32e709f43d';
const DELEGATOR = getAddress('0x1000000000000000000000000000000000000001');
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
    tokenId: BigInt(0),
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
  tokenId: number | bigint = 0,
  delegator = DELEGATOR
): DelegationStateEntry {
  return {
    delegator,
    delegate,
    expiry: BigInt(expiry),
    allTokens,
    tokenId: BigInt(tokenId)
  };
}

// A reader over stored entries in registration order (as the contract keeps
// them). The delegate list can be given in any order.
function readerFor(
  stored: DelegationStateEntry[],
  delegateList = stored.map((e) => e.delegate)
) {
  return {
    readDelegates: jest.fn(async (_query: DelegationStateQuery) =>
      delegateList.slice()
    ),
    readEntry: jest.fn(
      async (_query: DelegationStateQuery, delegate: string, index: number) => {
        const own = stored.filter(
          (e) => e.delegate.toLowerCase() === delegate.toLowerCase()
        );
        if (index >= own.length) {
          throw new Error('execution reverted');
        }
        return own[index];
      }
    )
  };
}

describe('delegationGlobalHash', () => {
  it('packs delegator, collection, delegate and use case like the contract', () => {
    const expected = keccak256(
      concat([
        DELEGATOR,
        COLLECTION,
        DELEGATE_A,
        zeroPadValue(toBeHex(997), 32)
      ])
    );
    expect(delegationGlobalHash(DELEGATOR, COLLECTION, DELEGATE_A, 997)).toBe(
      expected
    );
  });
});

describe('createDelegationStateReader', () => {
  const query = {
    block: 123,
    delegator: DELEGATOR,
    collection: COLLECTION,
    useCase: 2
  };

  it('reads the delegate list at the given block', async () => {
    const call = jest.fn(async (_to: string, _data: string, _block: number) =>
      DELEGATIONS_IFACE.encodeFunctionResult('retrieveDelegationAddresses', [
        [DELEGATE_A, DELEGATE_B, DELEGATE_A]
      ])
    );

    const delegates = await createDelegationStateReader(
      call,
      CONTRACT
    ).readDelegates(query);

    expect(delegates).toEqual([DELEGATE_A, DELEGATE_B, DELEGATE_A]);
    const [to, data, blockTag] = call.mock.calls[0];
    expect(to).toBe(CONTRACT);
    expect(blockTag).toBe(123);
    const args = DELEGATIONS_IFACE.decodeFunctionData(
      'retrieveDelegationAddresses',
      data
    );
    expect(args[0]).toBe(DELEGATOR);
    expect(args[1]).toBe(COLLECTION);
    expect(args[2]).toBe(BigInt(2));
  });

  it('reads one stored registration by global hash and index', async () => {
    const call = jest.fn(async (_to: string, _data: string, _block: number) =>
      DELEGATIONS_IFACE.encodeFunctionResult('globalDelegationHashes', [
        DELEGATOR,
        DELEGATE_A,
        BigInt(1_690_000_000),
        BigInt(1_800_000_000),
        false,
        BigInt(42)
      ])
    );

    const stored = await createDelegationStateReader(call, CONTRACT).readEntry(
      query,
      DELEGATE_A,
      3
    );

    expect(stored).toEqual(entry(DELEGATE_A, 1_800_000_000, false, 42));
    const [to, data, blockTag] = call.mock.calls[0];
    expect(to).toBe(CONTRACT);
    expect(blockTag).toBe(123);
    const args = DELEGATIONS_IFACE.decodeFunctionData(
      'globalDelegationHashes',
      data
    );
    expect(args[0]).toBe(
      delegationGlobalHash(DELEGATOR, COLLECTION, DELEGATE_A, 2)
    );
    expect(args[1]).toBe(BigInt(3));
  });

  it('throws when the call fails', async () => {
    const reader = createDelegationStateReader(
      jest.fn().mockRejectedValue(new Error('rpc down')),
      CONTRACT
    );
    await expect(reader.readDelegates(query)).rejects.toThrow('rpc down');
    await expect(reader.readEntry(query, DELEGATE_A, 0)).rejects.toThrow(
      'rpc down'
    );
  });

  it('throws when the result cannot be decoded', async () => {
    const reader = createDelegationStateReader(
      jest.fn().mockResolvedValue('0x'),
      CONTRACT
    );
    await expect(reader.readDelegates(query)).rejects.toThrow();
    await expect(reader.readEntry(query, DELEGATE_A, 0)).rejects.toThrow();
  });
});

describe('resolveRegistrationExpiries', () => {
  it('reads nothing when there are no registrations', async () => {
    const reader = readerFor([]);
    await expect(resolveRegistrationExpiries([], [], reader)).resolves.toEqual(
      []
    );
    expect(reader.readDelegates).not.toHaveBeenCalled();
  });

  it('matches registrations in one block to the latest stored entries in log order', async () => {
    const reader = readerFor([
      entry(DELEGATE_A, 1000, false, 7),
      entry(DELEGATE_B, 5555),
      entry(DELEGATE_A, 2000, false, 8),
      entry(DELEGATE_A, 3000, true, 0)
    ]);

    const expiries = await resolveRegistrationExpiries(
      [
        registration({ logIndex: 9, allTokens: true, tokenId: BigInt(5) }),
        registration({ logIndex: 4, allTokens: false, tokenId: BigInt(8) }),
        registration({ logIndex: 6, delegate: DELEGATE_B })
      ],
      [],
      reader
    );

    expect(expiries).toEqual([3000, 2000, 5555]);
    expect(reader.readDelegates).toHaveBeenCalledTimes(1);
    expect(reader.readDelegates).toHaveBeenCalledWith({
      block: 100,
      delegator: DELEGATOR,
      collection: COLLECTION,
      useCase: 2
    });
    const positions = reader.readEntry.mock.calls
      .map(([, delegate, index]) => `${delegate}:${index}`)
      .sort((a, b) => a.localeCompare(b));
    expect(positions).toEqual([
      `${DELEGATE_A}:1`,
      `${DELEGATE_A}:2`,
      `${DELEGATE_B}:0`
    ]);
  });

  it('does not depend on the order of the delegate list', async () => {
    const stored = [
      entry(DELEGATE_A, 1000),
      entry(DELEGATE_B, 2000),
      entry(DELEGATE_A, 3000)
    ];
    const expiries = await resolveRegistrationExpiries(
      [registration()],
      [],
      readerFor(stored, [DELEGATE_B, DELEGATE_A, DELEGATE_A])
    );
    expect(expiries).toEqual([3000]);
  });

  it('matches addresses case-insensitively', async () => {
    const expiries = await resolveRegistrationExpiries(
      [
        registration({
          delegate: DELEGATE_A.toLowerCase(),
          delegator: DELEGATOR.toLowerCase()
        })
      ],
      [],
      readerFor([entry(DELEGATE_A, 1234)])
    );
    expect(expiries).toEqual([1234]);
  });

  it('reads each block, delegator, collection and use case separately', async () => {
    const queries: DelegationStateQuery[] = [];
    const reader: DelegationStateReader = {
      readDelegates: async (query) => {
        queries.push(query);
        return [DELEGATE_A];
      },
      readEntry: async (query) =>
        entry(DELEGATE_A, query.block * 10 + query.useCase)
    };

    const expiries = await resolveRegistrationExpiries(
      [
        registration({ block: 100, useCase: 2 }),
        registration({ block: 100, useCase: 3 }),
        registration({ block: 101, useCase: 2 })
      ],
      [],
      reader
    );

    expect(expiries).toEqual([1002, 1003, 1012]);
    expect(queries).toHaveLength(3);
  });

  it('returns null without reading for a registration revoked later in the same block', async () => {
    const reader = readerFor([]);

    const expiries = await resolveRegistrationExpiries(
      [registration({ logIndex: 1 })],
      [revocation({ logIndex: 2 })],
      reader
    );

    expect(expiries).toEqual([null]);
    expect(reader.readDelegates).not.toHaveBeenCalled();
  });

  it('keeps a registration made after a revocation in the same block', async () => {
    const expiries = await resolveRegistrationExpiries(
      [registration({ logIndex: 1 }), registration({ logIndex: 3 })],
      [revocation({ logIndex: 2 }), revocation({ block: 99, logIndex: 9 })],
      readerFor([entry(DELEGATE_A, 4321)])
    );
    expect(expiries).toEqual([null, 4321]);
  });

  it('keeps only the registrations after the last revocation in a block', async () => {
    // register, revoke, register, revoke, register: each revocation deletes
    // the delegate's whole list, so only the last registration is stored.
    const reader = readerFor([entry(DELEGATE_A, 5000, false, 3)]);

    const expiries = await resolveRegistrationExpiries(
      [
        registration({ logIndex: 1 }),
        registration({ logIndex: 3, allTokens: false, tokenId: BigInt(2) }),
        registration({ logIndex: 5, allTokens: false, tokenId: BigInt(3) })
      ],
      [revocation({ logIndex: 2 }), revocation({ logIndex: 4 })],
      reader
    );

    expect(expiries).toEqual([null, null, 5000]);
    expect(reader.readEntry.mock.calls.map(([, , index]) => index)).toEqual([
      0
    ]);
  });

  it('reads registrations made after a same-block revocation from the start of the list', async () => {
    const reader = readerFor([
      entry(DELEGATE_A, 6000, false, 1),
      entry(DELEGATE_A, 7000, false, 2)
    ]);

    const expiries = await resolveRegistrationExpiries(
      [
        registration({ logIndex: 2, allTokens: false, tokenId: BigInt(1) }),
        registration({ logIndex: 3, allTokens: false, tokenId: BigInt(2) })
      ],
      [revocation({ logIndex: 1 })],
      reader
    );

    expect(expiries).toEqual([6000, 7000]);
    expect(
      reader.readEntry.mock.calls
        .map(([, , index]) => index)
        .sort((a, b) => a - b)
    ).toEqual([0, 1]);
  });

  it('throws when the contract holds fewer registrations than the logs', async () => {
    await expect(
      resolveRegistrationExpiries(
        [registration({ logIndex: 1 }), registration({ logIndex: 2 })],
        [],
        readerFor([entry(DELEGATE_A, 1)])
      )
    ).rejects.toThrow('Expected 2 stored registration(s)');
  });

  it('throws when the stored registration does not match the log', async () => {
    const mismatches: [RegistrationLogRef, DelegationStateEntry][] = [
      [
        registration({ allTokens: false, tokenId: BigInt(5) }),
        entry(DELEGATE_A, 1, false, 6)
      ],
      [registration({ allTokens: true }), entry(DELEGATE_A, 1, false, 0)],
      [
        registration(),
        entry(DELEGATE_A, 1, true, 0, getAddress('0x' + '9'.repeat(40)))
      ],
      [registration(), entry(DELEGATE_B, 1)]
    ];
    for (const [log, stored] of mismatches) {
      await expect(
        resolveRegistrationExpiries([log], [], {
          readDelegates: async () => [DELEGATE_A],
          readEntry: async () => stored
        })
      ).rejects.toThrow('does not match');
    }
  });

  it('compares token ids beyond the safe integer range exactly', async () => {
    // 2^60 + 1: Number() would round it.
    const tokenId = BigInt('1152921504606846977');
    await expect(
      resolveRegistrationExpiries(
        [registration({ allTokens: false, tokenId })],
        [],
        readerFor([entry(DELEGATE_A, 77, false, tokenId)])
      )
    ).resolves.toEqual([77]);
  });

  it('propagates a failed read', async () => {
    await expect(
      resolveRegistrationExpiries([registration()], [], {
        readDelegates: async () => [DELEGATE_A],
        readEntry: async () => {
          throw new Error('archive read failed');
        }
      })
    ).rejects.toThrow('archive read failed');
  });

  it('treats expiry dates beyond the safe integer range as never expiring', async () => {
    const expiries = await resolveRegistrationExpiries(
      [registration()],
      [],
      readerFor([entry(DELEGATE_A, BigInt('0x' + 'f'.repeat(64)))])
    );
    expect(expiries).toEqual([NEVER_DATE]);
  });

  it('runs at most five state reads at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async <T>(value: T): Promise<T> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return value;
    };
    const reader: DelegationStateReader = {
      readDelegates: () => track([DELEGATE_A]),
      readEntry: (query) => track(entry(DELEGATE_A, query.block))
    };
    const registrations = Array.from({ length: 12 }, (_, i) =>
      registration({ block: 200 + i })
    );

    const expiries = await resolveRegistrationExpiries(
      registrations,
      [],
      reader
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
        const stateAtBlock = new Map<
          number,
          Map<string, DelegationStateEntry[]>
        >();
        const registrations: RegistrationLogRef[] = [];
        const revocations: RevocationLogRef[] = [];
        const expected: (number | null)[] = [];
        for (const op of ordered) {
          if (op.kind === 'register') {
            const list = stored.get(op.delegate) ?? [];
            stored.set(
              op.delegate,
              list.concat([
                entry(
                  op.delegate,
                  op.expiry,
                  op.allTokens,
                  op.allTokens ? 0 : op.tokenId
                )
              ])
            );
            registrations.push(
              registration({
                block: op.block,
                logIndex: op.logIndex,
                delegate: op.delegate,
                allTokens: op.allTokens,
                tokenId: BigInt(op.tokenId)
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
          stateAtBlock.set(op.block, new Map(stored));
        }

        const state = (block: number) =>
          stateAtBlock.get(block) ?? new Map<string, DelegationStateEntry[]>();
        const expiries = await resolveRegistrationExpiries(
          registrations,
          revocations,
          {
            readDelegates: async (query) =>
              Array.from(state(query.block).entries()).reduce<string[]>(
                (all, [delegate, list]) => all.concat(list.map(() => delegate)),
                []
              ),
            readEntry: async (query, delegate, index) =>
              state(query.block).get(getAddress(delegate))![index]
          }
        );
        expect(expiries).toEqual(expected);
      })
    );
  });
});
