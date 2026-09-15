import { ErrorRequestHandler } from 'express';
import { Schema } from 'joi';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import {
  fail,
  normalizeJson
} from '@/artwork-documentation/artwork-documentation.validation';

export function validateDocumentationBody<T>(
  value: unknown,
  schema: Schema
): T {
  if (value === undefined) fail(422, 'INVALID_REQUEST');
  const result = schema.validate(normalizeJson(value), {
    convert: false,
    abortEarly: true,
    allowUnknown: false
  });
  if (result.error) fail(422, 'INVALID_REQUEST');
  return result.value as T;
}

export function sanitizeDocumentationError(
  error: unknown
): ApiCompliantException {
  if (error instanceof ApiCompliantException) {
    return new CustomApiCompliantException(
      error.getStatusCode(),
      error.message,
      error.code
    );
  }
  const parserError = error as { type?: unknown; status?: unknown } | null;
  if (
    parserError?.type === 'entity.parse.failed' &&
    parserError.status === 400
  ) {
    return new CustomApiCompliantException(
      400,
      'artworkDocumentation.errors.INVALID_JSON',
      'INVALID_JSON'
    );
  }
  if (parserError?.type === 'entity.too.large' && parserError.status === 413) {
    return new CustomApiCompliantException(
      413,
      'artworkDocumentation.errors.WRITE_REQUEST_LIMIT',
      'WRITE_REQUEST_LIMIT'
    );
  }
  return new CustomApiCompliantException(
    500,
    'artworkDocumentation.errors.DOCUMENTATION_OPERATION_FAILED',
    'DOCUMENTATION_OPERATION_FAILED'
  );
}

export const documentationErrorMiddleware: ErrorRequestHandler = (
  error,
  req,
  _res,
  next
) => {
  if (!req.path.startsWith('/api/artwork-documentation')) return next(error);
  req.body = undefined;
  req.query = {};
  // Parser errors can carry the full input. Recreate the exception with only
  // a known status/code before error integrations inspect it.
  return next(sanitizeDocumentationError(error));
};
