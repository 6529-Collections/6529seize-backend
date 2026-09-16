import type { ConnectionWrapper } from '@/sql-executor';
import {
  assertMembershipPrimaryContext,
  markMembershipTransactionFailed,
  membershipQueryOptions,
  withMembershipPrimaryMutationContext
} from './membership-primary';

const connection = { connection: {} } as ConnectionWrapper<unknown>;

describe('caller-owned membership mutation context', () => {
  it('pins repository work to the owner connection and revokes it afterwards', async () => {
    let captured:
      | Parameters<typeof assertMembershipPrimaryContext>[0]
      | undefined;
    await withMembershipPrimaryMutationContext(connection, async (ctx) => {
      captured = ctx;
      expect(membershipQueryOptions(ctx).wrappedConnection?.connection).toBe(
        connection.connection
      );
    });
    expect(() => assertMembershipPrimaryContext(captured!)).toThrow(
      'active primary transaction'
    );
  });

  it('throws a recorded repository failure even when the callback catches it', async () => {
    const failure = new Error('source write failed');
    await expect(
      withMembershipPrimaryMutationContext(connection, async (ctx) => {
        markMembershipTransactionFailed(ctx, failure);
        return 'incorrect success';
      })
    ).rejects.toBe(failure);
  });

  it('rejects nesting a caller request connection', async () => {
    await expect(
      withMembershipPrimaryMutationContext(connection, async () => undefined, {
        connection
      })
    ).rejects.toThrow('caller-owned WRITE transaction');
  });
});
