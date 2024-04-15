import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';

import { asyncRouter } from '../async.router';
import { ProfileClassification } from '../../../entities/IProfile';
import { sub_classification_to_classification } from './profile.helper';

const router = asyncRouter();

router.get(
  `/`,
  async function (
    _: Request<any, any, any, any, any>,
    res: Response<ApiResponse<Record<ProfileClassification, string[]>>>
  ) {
    const result = Object.entries(sub_classification_to_classification).reduce(
      (acc, r) => {
        const sub = r[0];
        const cls = r[1];
        cls.forEach((cl) => {
          if (!acc[cl]) {
            acc[cl] = [];
          }
          acc[cl].push(sub);
        });
        return acc;
      },
      {} as Record<ProfileClassification, string[]>
    );
    Object.entries(result).forEach((r) => r[1].sort());
    res.status(200).send(result);
  }
);
export default router;
