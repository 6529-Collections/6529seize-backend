import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { ABUSIVENESS_DETECTION_RESULTS_TABLE } from '../constants';
import { RequestContext } from '../request.context';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';

describeWithSeed(
  'AbusivenessCheckDb',
  {
    table: ABUSIVENESS_DETECTION_RESULTS_TABLE,
    rows: [
      {
        text: 'some allowed text',
        status: 'ALLOWED',
        explanation: 'ok',
        external_check_performed_at: new Date()
      },
      {
        text: 'another allowed text',
        status: 'ALLOWED',
        explanation: 'ok',
        external_check_performed_at: new Date()
      },
      {
        text: 'blocked text',
        status: 'DISALLOWED',
        explanation: 'bad',
        external_check_performed_at: new Date()
      },
      {
        text: 'longer allowed text here',
        status: 'ALLOWED',
        explanation: 'ok',
        external_check_performed_at: new Date()
      }
    ]
  },
  () => {
    const repo = new AbusivenessCheckDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('finds existing result', async () => {
      const r = await repo.findResult('some allowed text');
      expect(r).not.toBeNull();
      expect(r!.status).toBe('ALLOWED');
    });

    it('returns null when nothing matches', async () => {
      const r = await repo.findResult('not‑present');
      expect(r).toBeNull();
    });

    it('searches allowed texts with partial match', async () => {
      const results = await repo.searchAllowedTextsLike({
        text: 'allowed',
        limit: 10
      });
      expect(results).toHaveLength(3);
      expect(results).toContain('some allowed text');
      expect(results).toContain('another allowed text');
      expect(results).toContain('longer allowed text here');
    });

    it('searches allowed texts with limit', async () => {
      const results = await repo.searchAllowedTextsLike({
        text: 'allowed',
        limit: 2
      });
      expect(results).toHaveLength(2);
    });

    it('returns empty array when limit is less than 1', async () => {
      const results = await repo.searchAllowedTextsLike({
        text: 'allowed',
        limit: 0
      });
      expect(results).toHaveLength(0);
    });

    it('finds multiple results by exact text', async () => {
      const results = await repo.findResults(
        ['some allowed text', 'blocked text'],
        ctx
      );
      expect(results).toHaveLength(2);
      expect(results.find((r) => r.text === 'some allowed text')?.status).toBe(
        'ALLOWED'
      );
      expect(results.find((r) => r.text === 'blocked text')?.status).toBe(
        'DISALLOWED'
      );
    });

    it('returns empty array for empty input', async () => {
      const results = await repo.findResults([], ctx);
      expect(results).toHaveLength(0);
    });

    it('saves new result', async () => {
      const newResult: AbusivenessDetectionResult = {
        text: 'new test text',
        status: 'ALLOWED',
        explanation: 'test explanation',
        external_check_performed_at: new Date()
      };

      await repo.saveResult(newResult);
      const saved = await repo.findResult('new test text');
      expect(saved).not.toBeNull();
      expect(saved!.status).toBe('ALLOWED');
      expect(saved!.explanation).toBe('test explanation');
    });

    it('handles duplicate entries gracefully', async () => {
      const duplicateResult: AbusivenessDetectionResult = {
        text: 'some allowed text', // already exists from seed data
        status: 'ALLOWED',
        explanation: 'new explanation',
        external_check_performed_at: new Date()
      };

      const result = await repo.saveResult(duplicateResult);
      expect(result).not.toBeNull();
      expect(result!.text).toBe('some allowed text');
    });
  }
);
