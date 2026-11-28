import {
  aSignedProfileSite,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';

/**
 * The profile the publish seed's sites belong to: the first probe profile.
 * The seed reads it by wallet; the manifest's probes take the identity
 * world's values, since a probe's path holds literals.
 */
export interface PublishSeedProfile {
  readonly id: string;
  readonly handle: string;
}

/** The ids the publish seed writes and its probes ask about. */
export const PUBLISH_SEED_IDS = {
  grant: 'rebuild-publish-grant-1',
  proposal: 'rebuild-publish-proposal-1'
} as const;

/**
 * The publish seed's sites for `profile`, signed by the fixture wallet:
 * version 1, published; version 2, a draft; and an agent's candidate for
 * version 2.
 */
export function publishSeedSites(profile: PublishSeedProfile): {
  readonly published: SignedSiteFixture;
  readonly draft: SignedSiteFixture;
  readonly candidate: SignedSiteFixture;
} {
  const site = (version: number, title: string, draftId: string) =>
    aSignedProfileSite({
      profileId: profile.id,
      handle: profile.handle,
      draftId,
      version,
      title
    });
  return {
    published: site(1, 'Rebuild check site', 'rebuild-publish-draft-1'),
    draft: site(2, 'Rebuild check site, next draft', 'rebuild-publish-draft-2'),
    candidate: site(
      3,
      'Rebuild check site, agent change',
      'rebuild-publish-candidate'
    )
  };
}
