import { BadRequestException } from '@/exceptions';
import { CollaborationInvitation } from './meme-collaborations.db';

export const MAX_MEME_COLLABORATORS = 5;

export function currentCollaborationInvitations<
  T extends { profile_id: string }
>(invitations: T[]): T[] {
  // Repository order is creation time ascending. Each retry has a later timestamp.
  const latest = new Map(invitations.map((item) => [item.profile_id, item]));
  return invitations.filter((item) => latest.get(item.profile_id) === item);
}

export function validateCollaborationInvitees(
  ids: string[],
  authorId: string,
  previous: CollaborationInvitation[] = []
): void {
  if (new Set(ids).size !== ids.length || ids.includes(authorId))
    throw new BadRequestException(
      'Choose distinct collaborators, excluding yourself'
    );
  const current = currentCollaborationInvitations(previous);
  if (
    ids.some((id) =>
      current.some(
        (item) => item.profile_id === id && item.status === 'DECLINED'
      )
    )
  )
    throw new BadRequestException(
      'A declined collaboration invitation cannot be sent again'
    );
  if (
    ids.some((id) =>
      current.some(
        (item) => item.profile_id === id && item.status !== 'CANCELLED'
      )
    )
  )
    throw new BadRequestException(
      'This profile already has a collaboration invitation'
    );
  const occupied = current.filter(
    (item) => item.status === 'PENDING' || item.status === 'ACCEPTED'
  ).length;
  if (occupied + ids.length > MAX_MEME_COLLABORATORS)
    throw new BadRequestException(
      'You can have up to 5 pending or accepted collaborators'
    );
}
