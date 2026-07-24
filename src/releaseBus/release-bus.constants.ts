export const RELEASE_BUS_GITHUB_APP_ACTOR = '6529-release-bus[bot]';

export function isReleaseBusGitHubAppActor(
  actor: string | null | undefined
): boolean {
  return actor?.toLowerCase() === RELEASE_BUS_GITHUB_APP_ACTOR;
}
