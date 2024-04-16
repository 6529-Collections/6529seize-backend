import { Response } from 'express';
import { CONSOLIDATED_WALLETS_TDH_TABLE } from '../../constants';
import { sqlExecutor } from '../../sql-executor';
import {
  CONTENT_TYPE_HEADER,
  JSON_HEADER_VALUE,
  ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
  corsOptions
} from './api-constants';

export function returnJsonResult(result: any, response: Response) {
  response.setHeader(CONTENT_TYPE_HEADER, JSON_HEADER_VALUE);
  response.setHeader(
    ACCESS_CONTROL_ALLOW_ORIGIN_HEADER,
    corsOptions.allowedHeaders
  );
  response.json(result);
}

export const fetchSingleWalletTDH = async (wallet: string) => {
  const blockResult = await sqlExecutor.execute(
    `SELECT MAX(block) as block from ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );
  const block = blockResult[0].block ?? 0;
  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} where LOWER(consolidation_key) like '%${wallet.toLowerCase()}%'
  `;
  const tdh = await sqlExecutor.execute(sql);
  return {
    tdh: tdh[0]?.boosted_tdh ?? 0,
    block
  };
};
