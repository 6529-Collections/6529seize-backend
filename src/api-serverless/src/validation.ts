import * as Joi from 'joi';
import { BadRequestException } from '@/exceptions';

export function getValidatedByJoiOrThrow<T>(
  objToValidate: unknown,
  schema: Joi.ObjectSchema<T>
): T {
  const { error, value } = schema.validate(objToValidate);
  if (error) {
    throw new BadRequestException(error.message);
  }
  return value;
}
