import { BadRequestException } from '@/exceptions';

type QueryValues = Readonly<Record<string, unknown>> | undefined;

const DIGITS = /^\d+$/;

/**
 * The named query parameter as a single string, or undefined when it is
 * absent. A repeated (`?a=1&a=2`) or nested (`?a[b]=1`) parameter is a 400.
 */
export function optionalQueryString(
  query: QueryValues,
  name: string
): string | undefined {
  const value = query?.[name];
  if (value === undefined || typeof value === 'string') {
    return value;
  }
  throw new BadRequestException(`${name} must be a single value`);
}

/**
 * Like optionalQueryString, but a non-empty value must be a non-negative
 * integer written in digits.
 */
export function optionalQueryDigits(
  query: QueryValues,
  name: string
): string | undefined {
  const value = optionalQueryString(query, name);
  if (value && !DIGITS.test(value)) {
    throw new BadRequestException(`${name} must be a non-negative integer`);
  }
  return value;
}
