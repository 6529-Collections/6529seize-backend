jest.mock('./drops.api.service', () => ({ dropsService: {} }));
jest.mock('../auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  maybeAuthenticatedUser: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException } from '@/exceptions';
import { LightDropsQuerySchema } from './light-drops.routes';

function validate(query: Record<string, unknown>) {
  return getValidatedByJoiOrThrow(query, LightDropsQuerySchema);
}

describe('light drops query validation', () => {
  it('parses a full query', () => {
    const waveId = randomUUID();
    expect(
      validate({
        wave_id: waveId,
        limit: '50',
        min_serial_no: '10',
        max_serial_no: '20',
        older_first: 'true'
      })
    ).toEqual({
      wave_id: waveId,
      limit: 50,
      min_serial_no: 10,
      max_serial_no: 20,
      older_first: true
    });
  });

  it('defaults older_first to false and leaves serial bounds unset', () => {
    expect(validate({ limit: '1' })).toEqual({ limit: 1, older_first: false });
    expect(validate({ limit: '1', wave_id: '' }).wave_id).toBe('');
  });

  it('accepts any UUID wave id', () => {
    fc.assert(
      fc.property(fc.uuid(), (waveId) => {
        expect(validate({ limit: '1', wave_id: waveId }).wave_id).toBe(waveId);
      })
    );
  });

  it('keeps the existing limit messages', () => {
    expect(() => validate({})).toThrow('limit must be provided');
    expect(() => validate({ limit: '0' })).toThrow(
      'parsedLimit must be between 1 and 2000'
    );
    expect(() => validate({ limit: '2001' })).toThrow(
      'parsedLimit must be between 1 and 2000'
    );
    expect(() => validate({ limit: 'abc' })).toThrow(
      'parsedLimit must be between 1 and 2000'
    );
  });

  it.each([
    { limit: '1', wave_id: 'not-a-uuid' },
    { limit: '1', wave_id: `${randomUUID()}' or '1'='1` },
    { limit: '1', wave_id: [randomUUID()] },
    { limit: '1', wave_id: { id: randomUUID() } },
    { limit: '1', min_serial_no: 'x' },
    { limit: '1', max_serial_no: '1.5' },
    { limit: '1', older_first: 'sometimes' },
    { limit: ['1', '2'] }
  ])('rejects %p', (query) => {
    expect(() => validate(query)).toThrow(BadRequestException);
  });
});
