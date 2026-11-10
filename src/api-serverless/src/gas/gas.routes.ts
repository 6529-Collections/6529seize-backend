import { Request, Response } from 'express';
import { Logger } from '../../../logging';
import { returnCSVResult } from '../api-helpers';
import { asyncRouter } from '../async.router';
import { parseCollectionReportQuery } from '@/api/collection-report-query';
import { fetchGas, GasResponse } from './gas.db';

const router = asyncRouter();

const logger = Logger.get('GAS_API');

export default router;

router.get(
  `/collection/:collection_type`,
  async function (
    req: Request<
      {
        collection_type: string;
      },
      any,
      any,
      {
        primary?: string;
        artist?: string;
        from_date?: string;
        to_date?: string;
        from_block?: string;
        to_block?: string;
        download?: string;
      }
    >,
    res: Response<GasResponse[] | string>
  ) {
    const collectionType = req.params.collection_type;
    if (collectionType === 'memes' || collectionType === 'memelab') {
      const query = parseCollectionReportQuery(req.query);
      const results = await fetchGas(
        collectionType,
        query.primary,
        query.artist as string,
        query.from_date as string,
        query.to_date as string,
        query.from_block,
        query.to_block
      );
      logger.info(
        `[${collectionType.toUpperCase()} FROM_DATE ${query.from_date} TO_DATE ${query.to_date} - Fetched ${results.length}`
      );
      if (query.download) {
        results.forEach((r) => delete r.thumbnail);
        return returnCSVResult(`gas_${collectionType}`, results, res);
      }
      return res.json(results);
    } else {
      return res.status(404).send('Not found');
    }
  }
);
