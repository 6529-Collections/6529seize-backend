import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { dropsService } from './drops.api.service';
import { Timer } from '../../../time';
import { BadRequestException } from '../../../exceptions';
import { parseIntOrNull } from '../../../helpers';
import { ApiLightDrop } from '../generated/models/ApiLightDrop';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      { wave_id: string; limit: number; max_serial_no: number | null },
      any
    >,
    res: Response<ApiResponse<ApiLightDrop[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { wave_id, limit, max_serial_no } = req.query;
    if (!wave_id) {
      throw new BadRequestException('wave_id must be provided');
    }
    if (!limit) {
      throw new BadRequestException('limit must be provided');
    }
    const parsedLimit = parseIntOrNull(limit);
    if (parsedLimit === null || parsedLimit <= 0 || parsedLimit > 2000) {
      throw new BadRequestException('parsedLimit must be between 1 and 2000');
    }
    const maxSerialNo = parseIntOrNull(max_serial_no);
    const latestDrops = await dropsService.findLatestLightDrops(
      {
        waveId: wave_id,
        limit: parsedLimit,
        max_serial_no: maxSerialNo
      },
      { timer, authenticationContext }
    );
    res.send(latestDrops);
  }
);

export default router;
