import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverless = readFileSync(join(__dirname, 'serverless.yaml'), 'utf8');

function resourceBlock(resourceName: string): string {
  const match = serverless.match(
    new RegExp(
      `^    ${resourceName}:\\n([\\s\\S]*?)(?=^    \\S|(?![\\s\\S]))`,
      'm'
    )
  );

  if (!match?.[1]) {
    throw new Error(`Resource ${resourceName} not found`);
  }

  return match[1];
}

describe('transactions loop alarm configuration', () => {
  const functions = ['Memes', 'Gradients', 'MemeLab'] as const;

  it.each(functions)(
    'keeps %s invocation errors active in a rolling five-minute window',
    (functionName) => {
      const alarm = resourceBlock(`${functionName}TransactionsLoopErrorAlarm`);

      expect(alarm).toContain('MetricName: Errors');
      expect(alarm).toContain('EvaluationPeriods: 5');
      expect(alarm).toContain('DatapointsToAlarm: 1');
      expect(alarm).not.toContain('AlarmActions:');
      expect(alarm).not.toContain('OKActions:');
    }
  );

  it.each(functions)(
    'requires sustained %s throttling before raising a child alarm',
    (functionName) => {
      const alarm = resourceBlock(
        `${functionName}TransactionsLoopThrottleAlarm`
      );

      expect(alarm).toContain('MetricName: Throttles');
      expect(alarm).toContain('EvaluationPeriods: 5');
      expect(alarm).toContain('DatapointsToAlarm: 3');
      expect(alarm).not.toContain('AlarmActions:');
      expect(alarm).not.toContain('OKActions:');
    }
  );

  it('keeps invocation failures in the composite and delegates contention to the loop evaluator', () => {
    const alarm = resourceBlock('TransactionsLoopIncidentAlarm');

    expect(alarm).toContain('Type: AWS::CloudWatch::CompositeAlarm');
    for (const functionName of [
      'memesTransactionsLoop',
      'gradientsTransactionsLoop',
      'memeLabTransactionsLoop'
    ]) {
      expect(alarm).toContain(`${functionName}-Errors`);
      expect(alarm).not.toContain(`${functionName}-Throttles`);
    }
    expect(alarm.match(/ALARM\(/g)).toHaveLength(3);
    expect(alarm.match(/\bOR\b/g)).toHaveLength(2);
    expect(alarm).not.toMatch(/\bAND\b/);
    expect(alarm).toContain('AlarmActions:');
    expect(alarm).toContain('OKActions:');
  });

  it.each(functions)(
    'keeps %s OOM paging immediate and independent',
    (functionName) => {
      const alarm = resourceBlock(`${functionName}TransactionsLoopOOMAlarm`);

      expect(alarm).toContain('EvaluationPeriods: 1');
      expect(alarm).toContain('AlarmActions:');
      expect(alarm).toContain('OKActions:');
    }
  );
});
