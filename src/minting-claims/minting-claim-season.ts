export interface MintingClaimSeasonWindow {
  readonly currentSeason: number;
  readonly nextSeason: number;
}

export function getMintingClaimSeasonWindow(
  maxSeasonId: number
): MintingClaimSeasonWindow {
  const currentSeason = Math.max(1, maxSeasonId);
  return {
    currentSeason,
    nextSeason: currentSeason + 1
  };
}

export function isSeasonInMintingClaimCreationWindow(
  season: number,
  maxSeasonId: number
): boolean {
  const { currentSeason, nextSeason } =
    getMintingClaimSeasonWindow(maxSeasonId);
  return (
    Number.isInteger(season) && season >= currentSeason && season <= nextSeason
  );
}
