import type { Request, Response } from 'express';
import { ForbiddenException, UnauthorisedException } from '@/exceptions';

const mockAuthenticateSubscriptionsAdmin = jest.fn();

jest.mock('@/api/subscriptions/api.subscriptions.allowlist', () => ({
  authenticateSubscriptionsAdmin: (req: unknown) =>
    mockAuthenticateSubscriptionsAdmin(req)
}));

import { requireSubscriptionsAdmin } from '@/api/subscriptions/require-subscriptions-admin';

function run(middleware: ReturnType<typeof requireSubscriptionsAdmin>) {
  const req = {} as Request;
  const next = jest.fn();
  middleware(req, {} as Response, next);
  return { req, next };
}

describe('requireSubscriptionsAdmin', () => {
  beforeEach(() => {
    mockAuthenticateSubscriptionsAdmin.mockReset();
  });

  it('continues the chain for subscription admins', () => {
    mockAuthenticateSubscriptionsAdmin.mockReturnValue(true);

    const { req, next } = run(requireSubscriptionsAdmin('admins only'));

    expect(mockAuthenticateSubscriptionsAdmin).toHaveBeenCalledWith(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([false, null, undefined])(
    'rejects with a 403 ForbiddenException when the admin check returns %s',
    (adminCheckResult) => {
      mockAuthenticateSubscriptionsAdmin.mockReturnValue(adminCheckResult);

      const { next } = run(requireSubscriptionsAdmin('admins only'));

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.message).toBe('admins only');
      expect(error.getStatusCode()).toBe(403);
    }
  );

  it('can reject with a caller supplied exception type', () => {
    mockAuthenticateSubscriptionsAdmin.mockReturnValue(false);

    const { next } = run(
      requireSubscriptionsAdmin('admins only', UnauthorisedException)
    );

    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(UnauthorisedException);
    expect(error.getStatusCode()).toBe(401);
    expect(error.message).toBe('admins only');
  });
});
