import { getAuthenticatedProfileIdOrNull } from '@/api/auth/auth';
import { handleCreateProposalFrame } from '@/api/drops/proposal-frame.handlers';
import { CreateProposalFrameRequest } from '@/api/generated/routes/operations';
import { proposalFrameService } from '@/proposal-card/proposal-frame.service';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticatedProfileIdOrNull: jest.fn()
}));
jest.mock('@/proposal-card/proposal-frame.service', () => ({
  proposalFrameService: { publish: jest.fn() }
}));

describe('handleCreateProposalFrame', () => {
  const request = {
    body: { media_url: 'unused' }
  } as CreateProposalFrameRequest;

  beforeEach(() => jest.clearAllMocks());

  it('requires a profile before publication', async () => {
    jest.mocked(getAuthenticatedProfileIdOrNull).mockResolvedValue(null);
    await expect(handleCreateProposalFrame(request)).rejects.toThrow(
      'Please create a profile first'
    );
    expect(proposalFrameService.publish).not.toHaveBeenCalled();
  });

  it('passes the authenticated profile to the publisher', async () => {
    jest.mocked(getAuthenticatedProfileIdOrNull).mockResolvedValue('profile');
    await handleCreateProposalFrame(request);
    expect(proposalFrameService.publish).toHaveBeenCalledWith(
      request.body,
      'profile'
    );
  });
});
