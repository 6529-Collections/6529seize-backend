import * as Joi from 'joi';
import { BadRequestException } from '@/exceptions';

export function getValidatedByJoiOrThrow<T>(
  objToValidate: T,
  schema: Joi.ObjectSchema<T>
): T {
  const { error, value } = schema.validate(objToValidate);
  if (error) {
    throw new BadRequestException(error.message);
  }
  return value;
}
