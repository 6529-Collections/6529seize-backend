import * as Joi from 'joi';
import { BadRequestException } from '../../bad-request.exception';

export function getValidatedByJoiOrThrow<T>(
  objToValidate: T,
  schema: Joi.ObjectSchema<T>
) {
  const { error, value } = schema.validate(objToValidate);
  if (error) {
    throw new BadRequestException(error.message);
  }
  return value;
}
