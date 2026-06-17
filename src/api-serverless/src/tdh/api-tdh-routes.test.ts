const mockFetchConsolidatedMetrics = jest.fn();

jest.mock('../request-cache', () => ({
  cacheRequest: () => (_req: unknown, _res: unknown, next: () => void) =>
    next()
}));

jest.mock('./api.tdh.db', () => {
  const actual = jest.requireActual('./api.tdh.db');
  return {
    ...actual,
    fetchConsolidatedMetrics: mockFetchConsolidatedMetrics
  };
});

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'http';
import { BadRequestException, ApiCompliantException } from '@/exceptions';
import { MetricsConsolidatedTdhView } from './api.tdh.db';
import router, {
  resolveMetricsSort,
  resolveMetricsTdhView
} from './api.tdh.routes';

function createTestApp() {
  const app = express();
  app.use('/api/tdh', router);
  app.use(
    (err: Error, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof ApiCompliantException) {
        res.status(err.getStatusCode()).send({ error: err.message });
        next();
        return;
      }

      res.status(500).send({ error: 'Something went wrong...' });
      next(err);
    }
  );
  return app;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = createTestApp();
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }

    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function getRoute(path: string) {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentDisposition: response.headers.get('content-disposition'),
      body: await response.text()
    };
  });
}

describe('api.tdh.routes', () => {
  describe('resolveMetricsSort', () => {
    it('defaults to level when sort is omitted', () => {
      expect(resolveMetricsSort(undefined)).toBe('level');
    });

    it('supports tdh as the canonical TDH sort', () => {
      expect(resolveMetricsSort('tdh')).toBe('tdh');
    });

    it('keeps boosted_tdh as a backward-compatible sort key', () => {
      expect(resolveMetricsSort('boosted_tdh')).toBe('boosted_tdh');
    });

    it('normalizes supported sort casing', () => {
      expect(resolveMetricsSort('DAY_CHANGE')).toBe('day_change');
    });

    it('fails when sort is unsupported', () => {
      expect(() => resolveMetricsSort('unboosted_tdh')).toThrow(
        BadRequestException
      );
    });
  });

  describe('resolveMetricsTdhView', () => {
    it('defaults to boosted when tdh_view is omitted', () => {
      expect(resolveMetricsTdhView(undefined)).toBe(
        MetricsConsolidatedTdhView.BOOSTED
      );
    });

    it('supports unboosted tdh_view', () => {
      expect(resolveMetricsTdhView('unboosted')).toBe(
        MetricsConsolidatedTdhView.UNBOOSTED
      );
    });

    it('normalizes supported tdh_view casing', () => {
      expect(resolveMetricsTdhView('BOOSTED')).toBe(
        MetricsConsolidatedTdhView.BOOSTED
      );
    });

    it('fails when tdh_view is unsupported', () => {
      expect(() => resolveMetricsTdhView('raw')).toThrow(BadRequestException);
    });
  });

  describe('GET /api/tdh/consolidated_metrics', () => {
    beforeEach(() => {
      mockFetchConsolidatedMetrics.mockReset();
      mockFetchConsolidatedMetrics.mockResolvedValue({
        count: 1,
        page: 1,
        next: null,
        data: [
          {
            consolidation_key: 'abc',
            tdh: 10,
            tdh_view: 'boosted',
            boosted_tdh: 10,
            unboosted_tdh: 8,
            day_change: 1
          }
        ]
      });
    });

    it('returns 400 when sort is unsupported', async () => {
      const response = await getRoute(
        '/api/tdh/consolidated_metrics?sort=unboosted_tdh'
      );

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Unsupported sort field: unboosted_tdh'
      });
      expect(mockFetchConsolidatedMetrics).not.toHaveBeenCalled();
    });

    it('returns 400 when tdh_view is unsupported', async () => {
      const response = await getRoute(
        '/api/tdh/consolidated_metrics?tdh_view=raw'
      );

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Unsupported tdh_view: raw'
      });
      expect(mockFetchConsolidatedMetrics).not.toHaveBeenCalled();
    });

    it('returns paginated JSON for the default response path', async () => {
      const response = await getRoute(
        '/api/tdh/consolidated_metrics?sort=tdh&tdh_view=unboosted'
      );

      expect(response.status).toBe(200);
      expect(response.contentType).toContain('application/json');
      expect(JSON.parse(response.body)).toMatchObject({
        count: 1,
        page: 1,
        next: null,
        data: [
          {
            consolidation_key: 'abc',
            tdh: 10,
            tdh_view: 'boosted',
            boosted_tdh: 10,
            unboosted_tdh: 8,
            day_change: 1
          }
        ]
      });
      expect(mockFetchConsolidatedMetrics).toHaveBeenCalledWith(
        'tdh',
        'DESC',
        1,
        50,
        {
          search: undefined,
          content: undefined,
          collector: undefined,
          season: undefined,
          tdhView: MetricsConsolidatedTdhView.UNBOOSTED
        }
      );
    });

    it('returns CSV and requests all rows for download_all', async () => {
      const response = await getRoute(
        '/api/tdh/consolidated_metrics?download_all=true'
      );

      expect(response.status).toBe(200);
      expect(response.contentType).toContain('text/csv');
      expect(response.contentDisposition).toContain(
        'attachment; filename="consolidated_metrics.csv"'
      );
      expect(response.body).toContain('consolidation_key');
      expect(response.body).toContain('abc');
      expect(mockFetchConsolidatedMetrics).toHaveBeenCalledWith(
        'level',
        'DESC',
        1,
        Number.MAX_SAFE_INTEGER,
        {
          search: undefined,
          content: undefined,
          collector: undefined,
          season: undefined,
          tdhView: MetricsConsolidatedTdhView.BOOSTED
        }
      );
    });
  });
});
