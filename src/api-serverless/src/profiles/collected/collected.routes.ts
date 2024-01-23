import { asyncRouter } from '../../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../../api-response';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE, Page } from '../../page-request';
import {
  CardSeizedStatus,
  CollectedCard,
  CollectedQuery,
  CollectionType
} from './collected.types';
import { collectedService } from './collected.service';
import * as Joi from 'joi';
import { SortDirection } from '../../api-constants';
import { getValidatedByJoiOrThrow } from '../../validation';

const router = asyncRouter({
  mergeParams: true
});

router.get(
  `/`,
  async function (
    req: Request<
      {
        handleOrWallet: string;
      },
      any,
      any,
      {
        collection?: string;
        account_for_consolidations?: string;
        seized?: string;
        szn?: string;
        page?: string;
        page_size?: string;
        sort_direction?: string;
        sort?: string;
      },
      any
    >,
    res: Response<ApiResponse<Page<CollectedCard>>>
  ) {
    const query = getValidatedByJoiOrThrow(
      {
        handle_or_wallet: req.params.handleOrWallet,
        collection: req.query.collection as any,
        account_for_consolidations: req.query.account_for_consolidations as any,
        seized: req.query.seized as any,
        page_size: req.query.page_size as any,
        page: req.query.page as any,
        sort_direction: req.query.sort_direction as any,
        sort: req.query.sort as any,
        szn: req.query.szn as any
      },
      ApiGetCollectedCardsRequestSchema
    );
    const results = await collectedService.getCollectedCards(query);
    res.send(results);
  }
);

const ApiGetCollectedCardsRequestSchema: Joi.ObjectSchema<CollectedQuery> =
  Joi.object({
    handle_or_wallet: Joi.string().required(),
    collection: Joi.valid(...Object.values(CollectionType)).optional(),
    account_for_consolidations: Joi.boolean().optional().default(true),
    seized: Joi.valid(...Object.values(CardSeizedStatus))
      .optional()
      .default(CardSeizedStatus.ALL),
    szn: Joi.number().integer().positive().optional(),
    page: Joi.number().integer().positive().optional().default(1),
    page_size: Joi.number()
      .integer()
      .positive()
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .default(DEFAULT_PAGE_SIZE),
    sort_direction: Joi.string()
      .valid(...Object.values(SortDirection))
      .optional()
      .default(SortDirection.ASC),
    sort: Joi.string()
      .valid('token_id', 'tdh', 'rank')
      .optional()
      .default('token_id')
  });

export default router;
