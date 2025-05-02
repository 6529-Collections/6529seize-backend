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
      { wave_id: string; min_serial_no: number; max_serial_no: number | null },
      any
    >,
    res: Response<ApiResponse<ApiLightDrop[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { wave_id, min_serial_no, max_serial_no } = req.query;
    if (!wave_id) {
      throw new BadRequestException('wave_id must be provided');
    }
    if (!min_serial_no) {
      throw new BadRequestException('waveId must be provided');
    }
    const minSerialNo = parseIntOrNull(min_serial_no);
    if (minSerialNo === null || minSerialNo <= 0) {
      throw new BadRequestException('min_serial_no must be a positive integer');
    }
    const maxSerialNo = parseIntOrNull(max_serial_no);
    if (maxSerialNo !== null && maxSerialNo <= minSerialNo) {
      throw new BadRequestException(
        'max_serial_no must be bigger than min_serial_no'
      );
    }
    const latestDrops = await dropsService.findLatestLightDrops(
      {
        waveId: wave_id,
        min_serial_no,
        max_serial_no
      },
      { timer, authenticationContext }
    );
    res.send(latestDrops);
  }
);

export default router;
