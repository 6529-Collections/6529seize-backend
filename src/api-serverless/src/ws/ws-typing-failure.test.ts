import { typingFailureDetails } from './ws-typing-failure';

describe('typing failure diagnostic privacy', () => {
  it('keeps only fixed diagnostic labels', () => {
    const failure = Object.assign(new TypeError('private SQL and message'), {
      code: 'ER_BAD_FIELD_ERROR',
      sql: 'private query',
      name: 'private identity',
      connectionId: 'private connection'
    });
    expect(typingFailureDetails(failure)).toEqual({
      error_type: 'TypeError',
      error_code: 'ER_BAD_FIELD_ERROR'
    });
  });

  it.each([undefined, null, 'private content', { code: 'private identity' }])(
    'does not copy unknown errors or arbitrary codes: %p',
    (failure) => {
      expect(typingFailureDetails(failure)).toEqual({
        error_type: 'Unknown',
        error_code: 'OTHER'
      });
    }
  );
});
