import { asyncRouter } from '../../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../../api-response';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  Page,
  PageSortDirection
} from '../../page-request';
import {
  CardSeizedStatus,
  CollectedCard,
  CollectedQuery,
  CollectionType
} from './collected.types';
import { collectedService } from './collected.service';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../../validation';

const router = asyncRouter({
  mergeParams: true
});

router.get(
  `/`,
  async function (
    req: Request<
      {
        identity: string;
      },
      any,
      any,
      Omit<CollectedQuery, 'identity'>,
      any
    >,
    res: Response<ApiResponse<Page<CollectedCard>>>
  ) {
    const query = getValidatedByJoiOrThrow(
      {
        identity: req.params.identity,
        ...req.query
      },
      ApiGetCollectedCardsRequestSchema
    );
    const results = await collectedService.getCollectedCards(query);
    res.send(results);
  }
);

const ApiGetCollectedCardsRequestSchema: Joi.ObjectSchema<CollectedQuery> =
  Joi.object({
    identity: Joi.string().required(),
    collection: Joi.valid(...Object.values(CollectionType)).optional(),
    account_for_consolidations: Joi.boolean().optional().default(true),
    seized: Joi.valid(...Object.values(CardSeizedStatus))
      .optional()
      .default(CardSeizedStatus.ALL),
    szn: Joi.string().optional(),
    page: Joi.number().integer().positive().optional().default(1),
    page_size: Joi.number()
      .integer()
      .positive()
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .default(DEFAULT_PAGE_SIZE),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .optional()
      .default(PageSortDirection.ASC),
    sort: Joi.string()
      .valid('token_id', 'tdh', 'rank')
      .optional()
      .default('token_id')
  });

export default router;
