import { getAuthenticatedProfileIdOrNull } from '@/api/auth/auth';
import {
  CreateProposalFrameRequest,
  CreateProposalFrameResponse
} from '@/api/generated/routes/operations';
import { ForbiddenException } from '@/exceptions';
import { proposalFrameService } from '@/proposal-card/proposal-frame.service';

export async function handleCreateProposalFrame(
  req: CreateProposalFrameRequest
): Promise<CreateProposalFrameResponse> {
  const profileId = await getAuthenticatedProfileIdOrNull(req);
  if (!profileId) {
    throw new ForbiddenException('Please create a profile first');
  }
  return proposalFrameService.publish(req.body, profileId);
}
