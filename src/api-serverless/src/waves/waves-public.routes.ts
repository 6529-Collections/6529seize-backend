import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { Wave } from '../generated/models/Wave';
import { NotFoundException } from '../../../exceptions';
import { waveApiService } from './wave.api.service';
import { SearchWavesParams } from './waves.api.db';
import { validateWavesSearchParams } from './waves.routes';
import { Timer } from '../../../time';

const router = asyncRouter();

/**
 * DEPRECATED: Use /waves instead
 */
router.get(
  '/',
  async (
    req: Request<any, any, any, SearchWavesParams, any>,
    res: Response<ApiResponse<Wave[]>>
  ) => {
    const params = await validateWavesSearchParams(req);
    const waves = await waveApiService.searchWaves(params, {
      timer: Timer.getFromRequest(req)
    });
    res.send(waves);
  }
);

/**
 * DEPRECATED: Use /waves/:id instead
 */
router.get(
  '/:id',
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    const { id } = req.params;
    const wave = await waveApiService.findWaveByIdOrThrow(id, [], {});
    const groupId = wave.visibility.scope.group?.id;
    if (groupId) {
      throw new NotFoundException(`Wave ${id} not found`);
    }

    res.send(wave);
  }
);

export default router;
