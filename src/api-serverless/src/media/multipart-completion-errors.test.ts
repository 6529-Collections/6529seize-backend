import { BadRequestException } from '@/exceptions';
import { multipartCompletionClientError } from './multipart-completion-errors';

function named(name: string, message = 'S3 said no'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('multipartCompletionClientError', () => {
  it.each([
    'NoSuchUpload',
    'InvalidPart',
    'InvalidPartOrder',
    'EntityTooSmall'
  ])('maps %s to a 400 with the S3 message', (name) => {
    const mapped = multipartCompletionClientError(named(name, `${name} msg`));
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect(mapped?.getStatusCode()).toBe(400);
    expect(mapped?.message).toBe(`${name} msg`);
  });

  it('reads the code from Code when name is empty', () => {
    expect(
      multipartCompletionClientError({ name: '', Code: 'NoSuchUpload' })
    ).toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['another S3 error', named('InternalError')],
    ['access denied', named('AccessDenied')],
    ['a plain error', new Error('boom')],
    ['null', null],
    ['a string', 'NoSuchUpload']
  ])('leaves %s to the existing handling', (_, error) => {
    expect(multipartCompletionClientError(error)).toBeNull();
  });
});
