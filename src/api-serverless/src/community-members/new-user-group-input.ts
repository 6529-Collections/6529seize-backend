import { collections } from '@/collections';
import { enums } from '@/enums';
import {
  FilterDirection,
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode,
  GroupTdhInclusionStrategy
} from '@/entities/IUserGroup';
import { ApiCreateGroup } from '@/api/generated/models/ApiCreateGroup';
import { ApiGroupBeneficiaryGrantMatchMode } from '@/api/generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiGroupNftOwnershipMatchMode } from '@/api/generated/models/ApiGroupNftOwnershipMatchMode';
import {
  ApiGroupOwnsNft,
  ApiGroupOwnsNftNameEnum
} from '@/api/generated/models/ApiGroupOwnsNft';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import type { NewUserGroupInput } from './user-groups.service';

const DEFAULT_NFT_OWNERSHIP_MATCH_MODE =
  ApiGroupNftOwnershipMatchMode.AllTokens;

export async function toNewUserGroupInput(
  apiUserGroup: ApiCreateGroup
): Promise<NewUserGroupInput> {
  const relatedIdentities = collections.distinct(
    [
      apiUserGroup.group.rep.user_identity,
      apiUserGroup.group.cic.user_identity
    ].filter((it) => !!it) as string[]
  );
  const relatedIdentitiesMapped = await Promise.all(
    relatedIdentities.map(async (identity) => {
      const profileId = await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: identity },
        {}
      );
      return {
        given_identity: identity,
        profile_id: profileId
      };
    })
  );
  const ownsMemes = apiUserGroup.group.owns_nfts.find(
    (it) => it.name === ApiGroupOwnsNftNameEnum.Memes
  );
  const ownsGradient = apiUserGroup.group.owns_nfts.find(
    (it) => it.name === ApiGroupOwnsNftNameEnum.Gradients
  );
  const ownsLab = apiUserGroup.group.owns_nfts.find(
    (it) => it.name === ApiGroupOwnsNftNameEnum.Memelab
  );
  const ownsNextgen = apiUserGroup.group.owns_nfts.find(
    (it) => it.name === ApiGroupOwnsNftNameEnum.Nextgen
  );
  const beneficiaryGrantMatchMode =
    apiUserGroup.group.is_beneficiary_of_grant_match_mode ??
    ApiGroupBeneficiaryGrantMatchMode.AnyToken;
  const resolveNftOwnershipMatchMode = (ownsNft: ApiGroupOwnsNft | undefined) =>
    enums.resolveOrThrow(
      GroupNftOwnershipMatchMode,
      ownsNft?.match_mode ?? DEFAULT_NFT_OWNERSHIP_MATCH_MODE
    );
  const isPrivate = apiUserGroup.is_private ?? false;
  return {
    name: apiUserGroup.name,
    cic_min: apiUserGroup.group.cic.min,
    cic_max: apiUserGroup.group.cic.max,
    cic_user:
      relatedIdentitiesMapped.find((it) => {
        return it.given_identity === apiUserGroup.group.cic.user_identity;
      })?.profile_id ?? null,
    cic_direction: apiUserGroup.group.cic.direction
      ? (enums.resolve(FilterDirection, apiUserGroup.group.cic.direction) ??
        null)
      : null,
    rep_min: apiUserGroup.group.rep.min,
    rep_max: apiUserGroup.group.rep.max,
    rep_user:
      relatedIdentitiesMapped.find((it) => {
        return it.given_identity === apiUserGroup.group.rep.user_identity;
      })?.profile_id ?? null,
    rep_direction: apiUserGroup.group.rep.direction
      ? (enums.resolve(FilterDirection, apiUserGroup.group.rep.direction) ??
        null)
      : null,
    rep_category: apiUserGroup.group.rep.category,
    tdh_min: apiUserGroup.group.tdh.min,
    tdh_max: apiUserGroup.group.tdh.max,
    tdh_inclusion_strategy: enums.resolveOrThrow(
      GroupTdhInclusionStrategy,
      apiUserGroup.group.tdh.inclusion_strategy
    ),
    level_min: apiUserGroup.group.level.min,
    level_max: apiUserGroup.group.level.max,
    owns_meme: !!ownsMemes,
    owns_gradient: !!ownsGradient,
    owns_lab: !!ownsLab,
    owns_nextgen: !!ownsNextgen,
    owns_meme_tokens: ownsMemes?.tokens
      ? JSON.stringify(ownsMemes.tokens)
      : null,
    owns_meme_tokens_match_mode: resolveNftOwnershipMatchMode(ownsMemes),
    owns_gradient_tokens: ownsGradient?.tokens
      ? JSON.stringify(ownsGradient.tokens)
      : null,
    owns_gradient_tokens_match_mode: resolveNftOwnershipMatchMode(ownsGradient),
    owns_lab_tokens: ownsLab?.tokens ? JSON.stringify(ownsLab.tokens) : null,
    owns_lab_tokens_match_mode: resolveNftOwnershipMatchMode(ownsLab),
    owns_nextgen_tokens: ownsNextgen?.tokens
      ? JSON.stringify(ownsNextgen.tokens)
      : null,
    owns_nextgen_tokens_match_mode: resolveNftOwnershipMatchMode(ownsNextgen),
    addresses: apiUserGroup.group.identity_addresses?.length
      ? apiUserGroup.group.identity_addresses
      : [],
    excluded_addresses: apiUserGroup.group.excluded_identity_addresses ?? [],
    visible: false,
    is_private: isPrivate,
    is_direct_message: false,
    is_beneficiary_of_grant_id:
      apiUserGroup.group.is_beneficiary_of_grant_id ?? null,
    is_beneficiary_of_grant_match_mode: enums.resolveOrThrow(
      GroupBeneficiaryGrantMatchMode,
      beneficiaryGrantMatchMode
    )
  };
}
