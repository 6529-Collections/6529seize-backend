import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import {
  aSignedProfileSite,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';

/** The profile the publish seed's sites belong to: the first probe profile. */
export const PUBLISH_SEED_PROFILE = probeProfileId(1);

/** The ids the publish seed writes and its probes ask about. */
export const PUBLISH_SEED_IDS = {
  grant: 'rebuild-publish-grant-1',
  proposal: 'rebuild-publish-proposal-1'
} as const;

/**
 * The publish seed's sites, signed by the fixture wallet: version 1,
 * published; version 2, a draft; and an agent's candidate for version 2.
 */
export function publishSeedSites(): {
  readonly published: SignedSiteFixture;
  readonly draft: SignedSiteFixture;
  readonly candidate: SignedSiteFixture;
} {
  const site = (version: number, title: string, draftId: string) =>
    aSignedProfileSite({
      profileId: PUBLISH_SEED_PROFILE,
      handle: PUBLISH_SEED_PROFILE,
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
