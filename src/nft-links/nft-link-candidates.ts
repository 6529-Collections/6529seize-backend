const URL_CANDIDATE_REGEX = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const LEADING_PUNCTUATION = new Set(['(', '[', '{', '<', '"', "'"]);
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  '!',
  '?',
  ':',
  ';',
  '>',
  '"',
  "'"
]);

function trimToken(token: string): string {
  let result = token.trim();
  while (result.length && LEADING_PUNCTUATION.has(result[0])) {
    result = result.slice(1);
  }
  while (result.length && TRAILING_PUNCTUATION.has(result[result.length - 1])) {
    result = result.slice(0, -1);
  }
  while (result.endsWith(')')) {
    const opens = (result.match(/\(/g) ?? []).length;
    const closes = (result.match(/\)/g) ?? []).length;
    if (closes <= opens) {
      break;
    }
    result = result.slice(0, -1);
  }
  while (result.endsWith(']')) {
    const opens = (result.match(/\[/g) ?? []).length;
    const closes = (result.match(/\]/g) ?? []).length;
    if (closes <= opens) {
      break;
    }
    result = result.slice(0, -1);
  }
  while (result.endsWith('}')) {
    const opens = (result.match(/\{/g) ?? []).length;
    const closes = (result.match(/\}/g) ?? []).length;
    if (closes <= opens) {
      break;
    }
    result = result.slice(0, -1);
  }
  return result;
}

export function extractUrlCandidatesFromText(
  text: string | null | undefined,
  maxCandidates: number
): string[] {
  if (!text || maxCandidates <= 0) {
    return [];
  }
  const matches = text.match(URL_CANDIDATE_REGEX) ?? [];
  const deduplicated = new Set<string>();
  for (const match of matches) {
    const cleaned = trimToken(match);
    if (!cleaned) {
      continue;
    }
    deduplicated.add(cleaned);
    if (deduplicated.size >= maxCandidates) {
      break;
    }
  }
  return Array.from(deduplicated);
}
