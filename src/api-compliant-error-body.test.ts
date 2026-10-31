import {
  apiCompliantErrorBody,
  BadRequestException,
  CustomApiCompliantException
} from '@/exceptions';

describe('apiCompliantErrorBody', () => {
  it('keeps the existing shape for errors without details', () => {
    expect(apiCompliantErrorBody(new BadRequestException('bad'))).toEqual({
      error: 'bad'
    });
    expect(
      apiCompliantErrorBody(new CustomApiCompliantException(409, 'nope', 'X'))
    ).toEqual({ error: 'nope', code: 'X' });
  });

  it('adds details without letting them override error or code', () => {
    expect(
      apiCompliantErrorBody(
        new CustomApiCompliantException(409, 'stale', 'E2EE_EPOCH_STALE', {
          current_epoch: 4,
          error: 'spoofed',
          code: 'spoofed'
        })
      )
    ).toEqual({ error: 'stale', code: 'E2EE_EPOCH_STALE', current_epoch: 4 });
  });
});
