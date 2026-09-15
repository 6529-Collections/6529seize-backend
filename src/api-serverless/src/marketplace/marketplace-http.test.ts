import { Request, Response } from 'express';
import { CustomApiCompliantException } from '@/exceptions';
import { marketErrorMiddleware, sanitizeMarketError } from './marketplace.http';

describe('market error privacy boundary', () => {
  it.each([
    ['entity.parse.failed', 400, 'INVALID_JSON'],
    ['entity.too.large', 413, 'REQUEST_TOO_LARGE']
  ])('replaces %s input-bearing errors', (type, status, code) => {
    const result = sanitizeMarketError({
      type,
      status,
      body: 'private-signature',
      message: 'private-signature'
    });
    expect(result.getStatusCode()).toBe(status);
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('private-signature');
    expect(result.message).not.toContain('private-signature');
  });

  it('preserves safe API status without attached provider or input data', () => {
    const error = Object.assign(
      new CustomApiCompliantException(
        409,
        'Refresh this trade.',
        'OPERATION_CHANGED'
      ),
      { body: 'private-signature' }
    );
    const result = sanitizeMarketError(error);
    expect(result).not.toBe(error);
    expect(result.getStatusCode()).toBe(409);
    expect(result.code).toBe('OPERATION_CHANGED');
    expect(JSON.stringify(result)).not.toContain('private-signature');
  });

  it.each(['/api/market/operations/id/signature', '/api/collect/rules'])(
    'scrubs %s before error telemetry',
    (path) => {
      const req = {
        path,
        body: { signature: 'private-signature' },
        query: { signature: 'private-signature' }
      } as unknown as Request;
      const res = { set: jest.fn() } as unknown as Response;
      const next = jest.fn();
      marketErrorMiddleware(new Error('private-signature'), req, res, next);
      expect(req.body).toBeUndefined();
      expect(req.query).toEqual({});
      expect(res.set).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store'
      );
      expect(next.mock.calls[0][0].message).not.toContain('private-signature');
    }
  );

  it('leaves unrelated routes under their own error policies', () => {
    const error = new Error('unrelated');
    const req = {
      path: '/api/marketplace-unrelated',
      body: { value: 1 }
    } as unknown as Request;
    const next = jest.fn();
    marketErrorMiddleware(error, req, {} as Response, next);
    expect(next).toHaveBeenCalledWith(error);
    expect(req.body).toEqual({ value: 1 });
  });
});
