import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { RequestContext } from '../request.context';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import {
  anAbusivenessDetectionResult,
  withAbusivenessDetectionResults
} from '../tests/fixtures/abusiveness-detection-result.fixture';

const okResult1 = anAbusivenessDetectionResult({
  text: 'some allowed text',
  status: 'ALLOWED',
  explanation: 'ok'
});
const okResult2 = anAbusivenessDetectionResult({
  text: 'another allowed text',
  status: 'ALLOWED',
  explanation: 'ok'
});
const okResult3 = anAbusivenessDetectionResult({
  text: 'longer allowed text here',
  status: 'ALLOWED',
  explanation: 'ok'
});
const nokResult1 = anAbusivenessDetectionResult({
  text: 'blocked text',
  status: 'DISALLOWED',
  explanation: 'bad'
});

describeWithSeed(
  'AbusivenessCheckDb',
  withAbusivenessDetectionResults([
    okResult1,
    okResult2,
    okResult3,
    nokResult1
  ]),
  () => {
    const repo = new AbusivenessCheckDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('finds existing result', async () => {
      const r = await repo.findResult(okResult1.text);
      expect(r).not.toBeNull();
      expect(r!.status).toBe(okResult1.status);
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
      expect(results).toContain(okResult1.text);
      expect(results).toContain(okResult2.text);
      expect(results).toContain(okResult3.text);
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
        [okResult1.text, nokResult1.text],
        ctx
      );
      expect(results).toHaveLength(2);
      expect(results.find((r) => r.text === okResult1.text)?.status).toBe(
        okResult1.status
      );
      expect(results.find((r) => r.text === nokResult1.text)?.status).toBe(
        nokResult1.status
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
        text: okResult1.text,
        status: okResult1.status,
        explanation: 'new explanation',
        external_check_performed_at: new Date()
      };

      const result = await repo.saveResult(duplicateResult);
      expect(result).not.toBeNull();
      expect(result!.text).toBe(okResult1.text);
    });
  }
);
