/**
 * What the rules ask of the indexes besides the event itself. Each answer is
 * as of the event's position (its height for chain events, its anchor for
 * relay events), so a rebuild asks the same questions and gets the same
 * answers. Fixture-first, like the sources.
 */
export interface NotificationLookups {
  /** Followers of the wave (any action), as today's lifecycle notice uses. */
  waveFollowers(waveId: string, height: number): Promise<readonly string[]>;
  /** The creator's followers who are listed by name in any of the groups. */
  followersListedInGroups(
    creatorId: string,
    groupIds: readonly string[],
    height: number
  ): Promise<readonly string[]>;
  /** Everyone listed by name in any of the groups (a DM wave's members). */
  membersListedInGroups(
    groupIds: readonly string[],
    height: number
  ): Promise<readonly string[]>;
  /** Voters with a non-zero vote on the entry, and their values. */
  entryVoters(
    entryId: string,
    height: number
  ): Promise<readonly { readonly voterId: string; readonly value: number }[]>;
  /** People whose artwork alert on the artist was on before this time. */
  artworkAlertSubscribers(
    artistId: string,
    beforeMs: number
  ): Promise<readonly string[]>;
  /** Of these people, who can read the wave and its parent. */
  canReadWave(
    waveId: string,
    profileIds: readonly string[],
    height: number
  ): Promise<ReadonlySet<string>>;
  /** Of these people, who muted the wave. */
  mutedWave(
    waveId: string,
    profileIds: readonly string[],
    atMs: number
  ): Promise<ReadonlySet<string>>;
}
