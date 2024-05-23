import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { profilesService } from '../../../profiles/profiles.service';
import { asyncRouter } from '../async.router';
import { NotFoundException } from '../../../exceptions';
import { getHighestTdhAddressForConsolidationKey } from '../../../delegationsLoop/db.delegations';
import { fetchEns } from '../../../db-api';

const router = asyncRouter({ mergeParams: true });

interface AddressResult {
  consolidation_key: string;
  address: string;
  ens: string;
}

router.get(
  '/tdh-address',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<AddressResult>>
  ) => {
    const identity = req.params.identity;
    const consolidationKey = await profilesService
      .getProfileAndConsolidationsByIdentity(identity)
      .then((result) => result?.consolidation.consolidation_key);
    if (!consolidationKey) {
      throw new NotFoundException('Profile not found');
    }
    const highestTdhAddress = await getHighestTdhAddressForConsolidationKey(
      consolidationKey
    );
    const ens = await fetchEns(highestTdhAddress);
    const tdhAddress: AddressResult = {
      consolidation_key: consolidationKey,
      address: highestTdhAddress,
      ens: ens[0]?.display ?? ''
    };
    res.send(tdhAddress);
  }
);

export default router;
