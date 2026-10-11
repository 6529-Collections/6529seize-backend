import { USE_CASE_MINTING, USE_CASE_SUB_DELEGATION } from '@/constants';
import { toDelegationRow, writeDelegations } from '@/delegation-row';
import { Delegation, DelegationEvent, EventType } from '@/entities/IDelegation';
import { LessThan, MoreThanOrEqual, Repository } from 'typeorm';

function registration(overrides: Partial<DelegationEvent>): DelegationEvent {
  return {
    block: 10,
    type: EventType.REGISTER,
    wallet1: '0xcold',
    wallet2: '0xhot',
    collection: '0xcollection',
    use_case: USE_CASE_MINTING,
    ...overrides
  };
}

describe('toDelegationRow', () => {
  it('keeps a token-specific delegation scoped to its token', () => {
    const row = toDelegationRow(
      registration({ expiry: 1_900_000_000, all_tokens: false, token_id: 42 })
    );
    expect(row).toMatchObject({
      block: 10,
      from_address: '0xcold',
      to_address: '0xhot',
      collection: '0xcollection',
      use_case: USE_CASE_MINTING,
      expiry: 1_900_000_000,
      all_tokens: false,
      token_id: 42
    });
  });

  it('keeps a token-specific delegation for token 0', () => {
    const row = toDelegationRow(
      registration({ expiry: 1, all_tokens: false, token_id: 0 })
    );
    expect(row.all_tokens).toBe(false);
    expect(row.token_id).toBe(0);
  });

  it('stores an all-tokens delegation', () => {
    const row = toDelegationRow(
      registration({ expiry: 1_900_000_000, all_tokens: true, token_id: 0 })
    );
    expect(row.all_tokens).toBe(true);
    expect(row.token_id).toBe(0);
  });

  it('leaves values the event does not carry to the column defaults', () => {
    const row = toDelegationRow(
      registration({ use_case: USE_CASE_SUB_DELEGATION })
    );
    expect(row).not.toHaveProperty('expiry');
    expect(row).not.toHaveProperty('all_tokens');
    expect(row).not.toHaveProperty('token_id');
  });
});

type RepoCall =
  | { op: 'delete'; criteria: Record<string, unknown> }
  | { op: 'save'; rows: Delegation[]; options: unknown };

function fakeRepo(failOn?: RepoCall['op']) {
  const calls: RepoCall[] = [];
  const repo = {
    delete: jest.fn(async (criteria: Record<string, unknown>) => {
      if (failOn === 'delete') {
        throw new Error('delete failed');
      }
      calls.push({ op: 'delete', criteria });
      return { raw: [], affected: 0 };
    }),
    save: jest.fn(async (rows: Delegation[], options: unknown) => {
      if (failOn === 'save') {
        throw new Error('save failed');
      }
      calls.push({ op: 'save', rows, options });
      return rows;
    })
  };
  return { calls, repo: repo as unknown as Repository<Delegation> };
}

function revocation(overrides: Partial<DelegationEvent>): DelegationEvent {
  return registration({ type: EventType.REVOKE, ...overrides });
}

describe('writeDelegations', () => {
  it('deletes from the replay block, saves registrations, then applies revocations', async () => {
    const { calls, repo } = fakeRepo();

    await writeDelegations(
      repo,
      5,
      [
        registration({ block: 10, expiry: 1, all_tokens: true, token_id: 0 }),
        registration({ block: 11, wallet2: '0xother', expiry: 2 })
      ],
      [revocation({ block: 12 })]
    );

    expect(calls.map((c) => c.op)).toEqual(['delete', 'save', 'delete']);
    expect(calls[0]).toEqual({
      op: 'delete',
      criteria: { block: MoreThanOrEqual(5) }
    });
    const save = calls[1] as Extract<RepoCall, { op: 'save' }>;
    expect(save.rows.map((r) => [r.block, r.to_address, r.expiry])).toEqual([
      [10, '0xhot', 1],
      [11, '0xother', 2]
    ]);
    expect(save.options).toEqual({ chunk: 500 });
    expect(calls[2]).toEqual({
      op: 'delete',
      criteria: {
        from_address: '0xcold',
        to_address: '0xhot',
        use_case: USE_CASE_MINTING,
        collection: '0xcollection',
        block: LessThan(12)
      }
    });
  });

  it('skips the replay delete, save and revocations when there is nothing to apply', async () => {
    const { calls, repo } = fakeRepo();

    await writeDelegations(repo, undefined, [], []);

    expect(calls).toEqual([]);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('keeps the last registration in log order for rows that share the table key', async () => {
    const { calls, repo } = fakeRepo();

    await writeDelegations(
      repo,
      undefined,
      [
        registration({ expiry: 1, all_tokens: false, token_id: 7 }),
        registration({ wallet2: '0xother', expiry: 5 }),
        registration({
          wallet2: '0xHOT',
          expiry: 2,
          all_tokens: false,
          token_id: 8
        })
      ],
      []
    );

    const save = calls[0] as Extract<RepoCall, { op: 'save' }>;
    expect(save.rows.map((r) => [r.to_address, r.expiry, r.token_id])).toEqual([
      ['0xother', 5, undefined],
      ['0xHOT', 2, 8]
    ]);
  });

  it('stops at the first failed write so the transaction can roll back', async () => {
    const { calls, repo } = fakeRepo('save');

    await expect(
      writeDelegations(
        repo,
        undefined,
        [registration({ expiry: 1 })],
        [revocation({ block: 12 })]
      )
    ).rejects.toThrow('save failed');

    expect(calls).toEqual([]);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('applies revocations one at a time, in log order, and stops at the first failure', async () => {
    const { repo } = fakeRepo();
    const deleted: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    (repo.delete as jest.Mock).mockImplementation(
      async (criteria: { block: { value: number } }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        deleted.push(criteria.block.value);
        if (criteria.block.value === 14) {
          throw new Error('delete failed');
        }
        return { raw: [], affected: 0 };
      }
    );

    await expect(
      writeDelegations(
        repo,
        undefined,
        [],
        [
          revocation({ block: 12 }),
          revocation({ block: 14 }),
          revocation({ block: 13 })
        ]
      )
    ).rejects.toThrow('delete failed');

    expect(maxInFlight).toBe(1);
    expect(deleted).toEqual([12, 14]);
  });
});
