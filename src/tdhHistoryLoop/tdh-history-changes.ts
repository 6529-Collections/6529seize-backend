import type { TokenTDH } from '@/entities/ITDH';

export interface IndexedToken {
  token: TokenTDH;
  boost: number;
}

export type TokenIndex = Map<number, IndexedToken[]>;

export interface TokenTdhChanges {
  tdhCreated: number;
  tdhDestroyed: number;
  boostedTdhCreated: number;
  boostedTdhDestroyed: number;
  rawTdhCreated: number;
  rawTdhDestroyed: number;
  balanceCreated: number;
  balanceDestroyed: number;
}

interface TokenSnapshot {
  tdh: number;
  boostedTdh: number;
  rawTdh: number;
  balance: number;
}

export function addTokensToIndex(
  tokenIndex: TokenIndex,
  tokens: TokenTDH[] | undefined,
  boost: number
): void {
  for (const token of tokens ?? []) {
    const indexedTokens = tokenIndex.get(token.id) ?? [];
    indexedTokens.push({ token, boost });
    tokenIndex.set(token.id, indexedTokens);
  }
}

function aggregateSnapshot(tokens: IndexedToken[] | undefined): TokenSnapshot {
  return (tokens ?? []).reduce<TokenSnapshot>(
    (snapshot, indexedToken) => {
      snapshot.tdh += indexedToken.token.tdh;
      // Preserve legacy accounting by rounding each indexed entry before sum.
      snapshot.boostedTdh += Math.round(
        indexedToken.token.tdh * indexedToken.boost
      );
      snapshot.rawTdh += indexedToken.token.tdh__raw;
      snapshot.balance += indexedToken.token.balance;
      return snapshot;
    },
    {
      tdh: 0,
      boostedTdh: 0,
      rawTdh: 0,
      balance: 0
    }
  );
}

function applyDelta(
  changes: TokenTdhChanges,
  delta: number,
  createdField: keyof TokenTdhChanges,
  destroyedField: keyof TokenTdhChanges
): void {
  if (delta > 0) {
    changes[createdField] += delta;
  } else if (delta < 0) {
    changes[destroyedField] += -delta;
  }
}

export function calculateTokenTdhChanges(
  currentTokens: TokenTDH[] | undefined,
  currentBoost: number,
  previousTokenIndex: TokenIndex
): TokenTdhChanges {
  const currentTokenIndex: TokenIndex = new Map();
  addTokensToIndex(currentTokenIndex, currentTokens, currentBoost);

  return calculateTokenIndexTdhChanges(currentTokenIndex, previousTokenIndex);
}

export function calculateTokenIndexTdhChanges(
  currentTokenIndex: TokenIndex,
  previousTokenIndex: TokenIndex
): TokenTdhChanges {
  const tokenIds = new Set<number>();
  currentTokenIndex.forEach((_tokens, tokenId) => tokenIds.add(tokenId));
  previousTokenIndex.forEach((_tokens, tokenId) => tokenIds.add(tokenId));
  const changes: TokenTdhChanges = {
    tdhCreated: 0,
    tdhDestroyed: 0,
    boostedTdhCreated: 0,
    boostedTdhDestroyed: 0,
    rawTdhCreated: 0,
    rawTdhDestroyed: 0,
    balanceCreated: 0,
    balanceDestroyed: 0
  };

  tokenIds.forEach((tokenId) => {
    const current = aggregateSnapshot(currentTokenIndex.get(tokenId));
    const previous = aggregateSnapshot(previousTokenIndex.get(tokenId));

    applyDelta(
      changes,
      current.tdh - previous.tdh,
      'tdhCreated',
      'tdhDestroyed'
    );
    applyDelta(
      changes,
      current.boostedTdh - previous.boostedTdh,
      'boostedTdhCreated',
      'boostedTdhDestroyed'
    );
    applyDelta(
      changes,
      current.rawTdh - previous.rawTdh,
      'rawTdhCreated',
      'rawTdhDestroyed'
    );
    applyDelta(
      changes,
      current.balance - previous.balance,
      'balanceCreated',
      'balanceDestroyed'
    );
  });

  return changes;
}
