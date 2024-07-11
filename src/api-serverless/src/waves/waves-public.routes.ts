import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { Wave } from '../generated/models/Wave';
import { NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import { waveApiService } from './wave.api.service';
import { SearchWavesParams } from './waves.api.db';

const router = asyncRouter();

router.get(
  '/',
  async (
    req: Request<any, any, any, SearchWavesParams, any>,
    res: Response<ApiResponse<Wave[]>>
  ) => {
    const params = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<SearchWavesParams>({
        limit: Joi.number().integer().min(1).max(50).default(20),
        serial_no_less_than: Joi.number().integer().min(1).optional(),
        group_id: Joi.string().optional().min(1)
      })
    );
    const waves = await waveApiService.searchWaves(params);
    res.send(waves);
  }
);

router.get(
  '/:id',
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<Wave>>
  ) => {
    const { id } = req.params;
    const wave = await waveApiService.findWaveByIdOrThrow(id, []);
    const groupId = wave.visibility.scope.group?.id;
    if (groupId) {
      throw new NotFoundException(`Wave ${id} not found`);
    }

    res.send(wave);
  }
);

export default router;
