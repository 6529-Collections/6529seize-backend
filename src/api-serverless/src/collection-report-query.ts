import * as Joi from 'joi';
import { resolveIntParam } from '@/api/api-helpers';
import { getValidatedByJoiOrThrow } from '@/api/validation';

/** Query accepted by the gas and royalties collection reports. */
export interface CollectionReportQuery {
  primary: boolean;
  artist?: string;
  from_date?: string;
  to_date?: string;
  from_block?: number;
  to_block?: number;
  download: boolean;
}

const MAX_ARTIST_LENGTH = 200;
// A calendar date, optionally followed by an ISO time of day.
const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const dateSchema = Joi.string()
  .allow('')
  .max(40)
  .pattern(DATE_PATTERN)
  .custom((value: string, helpers) =>
    Number.isNaN(Date.parse(value)) ? helpers.error('any.invalid') : value
  );

const textFieldsSchema = Joi.object<{
  artist?: string;
  from_date?: string;
  to_date?: string;
}>({
  artist: Joi.string().allow('').max(MAX_ARTIST_LENGTH),
  from_date: dateSchema,
  to_date: dateSchema
}).unknown(true);

/**
 * Parses the shared gas/royalties report query. `primary` and `download`
 * are true only for the literal "true" and blocks ignore non-integers, as
 * before; malformed dates or an overlong artist name are a 400.
 */
export function parseCollectionReportQuery(
  query: Record<string, unknown> | undefined
): CollectionReportQuery {
  const source = query ?? {};
  const text = getValidatedByJoiOrThrow(source, textFieldsSchema);
  return {
    primary: source.primary === 'true',
    artist: text.artist || undefined,
    from_date: text.from_date || undefined,
    to_date: text.to_date || undefined,
    from_block: resolveIntParam(source.from_block as string | undefined),
    to_block: resolveIntParam(source.to_block as string | undefined),
    download: source.download === 'true'
  };
}

/** Escapes the characters MySQL's regular expression engine treats specially. */
export function escapeMysqlRegExp(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, String.raw`\$&`);
}

/**
 * The REGEXP parameter matching one artist inside a comma or " and "
 * separated artist list, with the artist name matched literally.
 */
export function artistListRegExp(artist: string): string {
  return `(^|,| and )${escapeMysqlRegExp(artist)}($|,| and )`;
}
