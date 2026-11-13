import { customErrorMiddleware } from '@/api/api-error-middleware';
import { WriteBusyException } from '@/api/write-transaction-budget';
import { BadRequestException } from '@/exceptions';
import { SqlParameterValueError } from '@/db/sql-named-parameters';

type FakeResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  set: (name: string, value: string) => FakeResponse;
  status: (code: number) => FakeResponse;
  send: (body: unknown) => FakeResponse;
};

function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
    set: (name, value) => {
      res.headers[name] = value;
      return res;
    },
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    send: (body) => {
      res.body = body;
      return res;
    }
  };
  return res;
}

describe('customErrorMiddleware', () => {
  it('answers a busy write with 503 and Retry-After', () => {
    const res = fakeResponse();
    const next = jest.fn();
    customErrorMiddleware()(
      new WriteBusyException(),
      {} as never,
      res as never,
      next
    );
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.body).toEqual({
      error: 'The server is busy. Please try again.',
      code: 'WRITE_BUSY'
    });
    expect(next).toHaveBeenCalledWith();
  });

  it('sends no Retry-After for other API errors', () => {
    const res = fakeResponse();
    customErrorMiddleware()(
      new BadRequestException('bad'),
      {} as never,
      res as never,
      jest.fn()
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers['Retry-After']).toBeUndefined();
  });

  it('answers an unsupported SQL parameter value with 400', () => {
    const res = fakeResponse();
    const next = jest.fn();
    customErrorMiddleware()(
      new SqlParameterValueError('contract'),
      {} as never,
      res as never,
      next
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request parameter' });
    expect(next).toHaveBeenCalledWith();
  });

  it('answers other errors with 500 and passes them on', () => {
    const res = fakeResponse();
    const next = jest.fn();
    const error = new Error('boom');
    customErrorMiddleware()(error, {} as never, res as never, next);
    expect(res.statusCode).toBe(500);
    expect(next).toHaveBeenCalledWith(error);
  });
});
