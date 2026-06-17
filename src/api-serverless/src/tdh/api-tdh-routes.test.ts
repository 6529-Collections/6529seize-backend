import { BadRequestException } from '@/exceptions';
import { MetricsConsolidatedTdhView } from './api.tdh.db';
import { resolveMetricsSort, resolveMetricsTdhView } from './api.tdh.routes';

describe('api.tdh.routes', () => {
  describe('resolveMetricsSort', () => {
    it('defaults to level when sort is omitted', () => {
      expect(resolveMetricsSort(undefined)).toBe('level');
    });

    it('supports tdh as the canonical TDH sort', () => {
      expect(resolveMetricsSort('tdh')).toBe('tdh');
    });

    it('keeps boosted_tdh as a backward-compatible alias for tdh', () => {
      expect(resolveMetricsSort('boosted_tdh')).toBe('tdh');
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
});
