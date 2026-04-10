import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { dropsService } from './drops.api.service';
import { Timer } from '@/time';
import { BadRequestException } from '@/exceptions';
import { ApiLightDrop } from '../generated/models/ApiLightDrop';
import { numbers } from '@/numbers';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        wave_id?: string;
        limit: number;
        min_serial_no: number | null;
        max_serial_no: number | null;
        older_first?: string;
      },
      any
    >,
    res: Response<ApiResponse<ApiLightDrop[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { wave_id, limit, max_serial_no, min_serial_no, older_first } =
      req.query;
    if (!limit) {
      throw new BadRequestException('limit must be provided');
    }
    const parsedLimit = numbers.parseIntOrNull(limit);
    if (parsedLimit === null || parsedLimit <= 0 || parsedLimit > 2000) {
      throw new BadRequestException('parsedLimit must be between 1 and 2000');
    }
    const maxSerialNo = numbers.parseIntOrNull(max_serial_no);
    const minSerialNo = numbers.parseIntOrNull(min_serial_no);
    const olderFirst = older_first === 'true';
    const latestDrops = await dropsService.findLatestLightDrops(
      {
        waveId: wave_id ?? null,
        limit: parsedLimit,
        max_serial_no: maxSerialNo,
        min_serial_no: minSerialNo,
        older_first: olderFirst
      },
      { timer, authenticationContext }
    );
    res.send(latestDrops);
  }
);

export default router;
