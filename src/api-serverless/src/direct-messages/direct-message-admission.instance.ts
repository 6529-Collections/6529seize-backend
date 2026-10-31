import { userGroupsService } from '../community-members/user-groups.service';

/**
 * The shared inbound direct-message admission service. Legacy DM creation
 * uses this same instance through `UserGroupsService`; encrypted DM and group
 * creation should import it from here. See `DirectMessageAdmissionService`.
 */
export const directMessageAdmissionService =
  userGroupsService.directMessageAdmission;
