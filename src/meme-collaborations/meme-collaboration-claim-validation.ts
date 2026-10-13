import type {
  MemeCollaborationArtwork,
  MemeCollaborationEntity
} from '@/entities/IMemeCollaboration';
import { BadRequestException } from '@/exceptions';
import { assertCollaborationCredit } from './meme-collaboration-credit';

type ClaimArtwork = {
  [Key in keyof MemeCollaborationArtwork]?:
    | MemeCollaborationArtwork[Key]
    | null;
};
const ARTWORK_FIELDS = [
  'name',
  'description',
  'image_url',
  'animation_url'
] as const;

export function assertCollaborationClaimPatch(
  patch: ClaimArtwork & { attributes?: unknown },
  collaboration: MemeCollaborationEntity | null
): void {
  if (!collaboration?.credit) return;
  if (patch.attributes !== undefined)
    assertCollaborationCredit(patch.attributes, collaboration.credit);
  if (!collaboration.credit.collab) return;
  const changedArtwork = ARTWORK_FIELDS.some(
    (key) =>
      patch[key] !== undefined && patch[key] !== collaboration.artwork[key]
  );
  if (changedArtwork)
    throw new BadRequestException(
      'Accepted collaboration locks the artwork, title and description. Create a new submission to replace them.'
    );
}

export function assertCollaborationClaimPublication(
  claim: ClaimArtwork,
  attributes: unknown,
  collaboration: MemeCollaborationEntity | null
): void {
  if (!collaboration) return;
  if (!collaboration.credit)
    throw new BadRequestException(
      'Missing accepted-artist snapshot for this claim'
    );
  assertCollaborationCredit(attributes, collaboration.credit);
  if (!collaboration.credit.collab) return;
  const changedArtwork = ARTWORK_FIELDS.some(
    (key) => claim[key] !== collaboration.artwork[key]
  );
  if (changedArtwork)
    throw new BadRequestException(
      'Claim artwork differs from accepted collaboration artwork'
    );
}
