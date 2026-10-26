interface WaveNameSearchSql {
  candidateFilter: string;
  filter: string;
  rank: string;
  params: Record<string, unknown>;
}

export function buildWaveNameSearchSql(name: string): WaveNameSearchSql | null {
  // Match NFT search normalization, without its three-character minimum.
  const punctuation = String.raw`[^\p{L}\p{N}%_\\]`;
  const normalize = (value: string) =>
    value.replace(new RegExp(punctuation, 'gu'), '');
  const query = name.trim();
  const normalizedQuery = normalize(query);
  if (normalizedQuery.replace(/[%_\\]/g, '').length === 0) {
    return null;
  }

  const escapeLike = (value: string) => value.replace(/[!%_]/g, '!$&');
  const separators = /[^\p{L}\p{N}%_\\'’]+/u;
  const terms = Array.from(
    new Set(query.split(separators).map(normalize).filter(Boolean))
  ).sort((left, right) => right.length - left.length);
  const params: Record<string, unknown> = {
    searchPunctuation: punctuation,
    searchExactName: query,
    searchNormalizedName: normalizedQuery,
    searchPhrase: `%${escapeLike(normalizedQuery)}%`,
    // Normalization only deletes characters: every match contains this term
    // as a subsequence. Narrow candidates before doing regex work.
    searchCandidate: `%${Array.from(terms[0]).map(escapeLike).join('%')}%`
  };
  const filter = terms
    .map((term, index) => {
      params[`searchTerm${index}`] = `%${escapeLike(term)}%`;
      return `normalized_name like :searchTerm${index} escape '!'`;
    })
    .join(' and ');

  return {
    candidateFilter: "w.name like :searchCandidate escape '!'",
    filter,
    rank: `case
      when name = :searchExactName then 0
      when normalized_name = :searchNormalizedName then 1
      when normalized_name like :searchPhrase escape '!' then 2
      else 3
    end`,
    params
  };
}
