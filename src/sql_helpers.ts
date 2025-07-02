import { CONSOLIDATIONS_TABLE } from './constants';

export function getConsolidationsSql() {
  return `
    WITH RECURSIVE wallet_cluster AS (
      SELECT wallet1, wallet2
      FROM ${CONSOLIDATIONS_TABLE}
      WHERE confirmed = true
        AND (:wallet IN (wallet1, wallet2))

      UNION

      SELECT c.wallet1, c.wallet2
      FROM ${CONSOLIDATIONS_TABLE} c
      INNER JOIN wallet_cluster wc
          ON c.wallet1 = wc.wallet2
          OR c.wallet2 = wc.wallet1
          OR c.wallet1 = wc.wallet1
          OR c.wallet2 = wc.wallet2
      WHERE c.confirmed = true
    )
    SELECT DISTINCT *
    FROM ${CONSOLIDATIONS_TABLE}
    WHERE confirmed = true
      AND (wallet1 IN (
            SELECT wallet1 FROM wallet_cluster
            UNION
            SELECT wallet2 FROM wallet_cluster
          )
        OR wallet2 IN (
            SELECT wallet1 FROM wallet_cluster
            UNION
            SELECT wallet2 FROM wallet_cluster
          ))
    ORDER BY block DESC
  `;
}

export function parseTdhResultsFromDB(results: any) {
  results.data = results.data.map((d: any) => parseTdhDataFromDB(d));
  return results;
}

export function parseTdhDataFromDB(d: any) {
  if (d.memes) {
    d.memes = JSON.parse(d.memes);
  }
  if (d.memes_ranks) {
    d.memes_ranks = JSON.parse(d.memes_ranks);
  }
  if (d.gradients) {
    d.gradients = JSON.parse(d.gradients);
  }
  if (d.gradients_ranks) {
    d.gradients_ranks = JSON.parse(d.gradients_ranks);
  }
  if (d.nextgen) {
    d.nextgen = JSON.parse(d.nextgen);
  }
  if (d.nextgen_ranks) {
    d.nextgen_ranks = JSON.parse(d.nextgen_ranks);
  }
  if (d.wallets) {
    if (!Array.isArray(d.wallets)) {
      d.wallets = JSON.parse(d.wallets);
    }
  }
  if (d.boost_breakdown) {
    d.boost_breakdown = JSON.parse(d.boost_breakdown);
  }
  return d;
}
