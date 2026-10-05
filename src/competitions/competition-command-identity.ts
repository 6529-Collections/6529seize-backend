import { createHash } from 'node:crypto';

/** The same canonical encoding is used by command retries and native signing. */
export function canonicalCompetitionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Invalid competition payload');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCompetitionJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => (left < right ? -1 : Number(left > right)))
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalCompetitionJson(record[key])}`
    )
    .join(',')}}`;
}

export function competitionPayloadHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalCompetitionJson(value))
    .digest('hex');
}
