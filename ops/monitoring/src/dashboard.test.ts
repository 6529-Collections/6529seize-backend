import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type MetricOptions = {
  stat?: string;
  accountId?: string;
  region?: string;
  expression?: string;
  label?: string;
};
type Widget = {
  x: number;
  y: number;
  width: number;
  height: number;
  properties: {
    accountId?: string;
    region?: string;
    title?: string;
    metrics?: (string | MetricOptions)[][];
    markdown?: string;
  };
};
function load(environment: string) {
  const template = JSON.parse(
    readFileSync(
      new URL(`../dashboard-${environment}.json`, import.meta.url),
      'utf8'
    )
  );
  const body = JSON.parse(
    template.Resources.Dashboard.Properties.DashboardBody['Fn::Sub']
  ) as { widgets: Widget[] };
  return {
    template,
    body,
    metrics: body.widgets.flatMap((widget) => widget.properties.metrics ?? [])
  };
}
function options(metric: (string | MetricOptions)[]): MetricOptions {
  return metric.at(-1) as MetricOptions;
}

test('dashboards bind native REST metrics to exact source account, region and dimensions', () => {
  for (const environment of ['prod', 'staging']) {
    const { template, metrics } = load(environment);
    assert.deepEqual(template.Parameters.Environment.AllowedValues, [
      environment
    ]);
    assert.equal(template.Parameters.SourceAccountId.Default, undefined);
    const api = metrics.filter((metric) => metric[0] === 'AWS/ApiGateway');
    assert.ok(api.length > 0);
    for (const metric of api) {
      assert.deepEqual(metric.slice(2, 6), [
        'ApiName',
        '${RestApiName}',
        'Stage',
        '${RestApiStage}'
      ]);
      assert.equal(options(metric).accountId, '${SourceAccountId}');
      assert.equal(options(metric).region, '${SourceRegion}');
      if (metric[1] === 'Count')
        assert.equal(options(metric).stat, 'SampleCount');
    }
    for (const name of ['Latency', 'IntegrationLatency']) {
      assert.deepEqual(
        api
          .filter((metric) => metric[1] === name)
          .map((metric) => options(metric).stat),
        ['p50', 'p95', 'p99']
      );
    }
  }
});

test('production ALB rate preserves target selection scope and pre-target failure signals', () => {
  const { metrics } = load('prod');
  const alb = metrics.filter((metric) => metric[0] === 'AWS/ApplicationELB');
  for (const metric of alb) {
    assert.deepEqual(metric.slice(2, 4), [
      'LoadBalancer',
      '${WebsiteLoadBalancer}'
    ]);
    if (metric[1] === 'HTTPCode_ELB_5XX_Count') assert.equal(metric.length, 5);
    else
      assert.deepEqual(metric.slice(4, 6), [
        'TargetGroup',
        '${WebsiteTargetGroup}'
      ]);
    assert.equal(options(metric).accountId, '${SourceAccountId}');
    assert.equal(options(metric).region, '${SourceRegion}');
  }
  for (const name of [
    'TargetResponseTime',
    'RequestCount',
    'HTTPCode_Target_5XX_Count',
    'HTTPCode_ELB_5XX_Count',
    'UnHealthyHostCount'
  ]) {
    assert.ok(
      alb.some((metric) => metric[1] === name),
      name
    );
  }
  const staging = load('staging');
  assert.equal(
    staging.metrics.some((metric) => metric[0] === 'AWS/ApplicationELB'),
    false
  );
  assert.ok(
    staging.body.widgets.some((widget) =>
      widget.properties.markdown?.includes('request telemetry gap')
    )
  );
});

test('dashboards retain heartbeat, queue and missing-telemetry boundaries with a non-overlapping layout', () => {
  for (const environment of ['prod', 'staging']) {
    const { metrics, body } = load(environment);
    const heartbeats = metrics.filter((metric) => metric[1] === 'HeartbeatAge');
    assert.deepEqual(
      heartbeats.map((metric) => metric.slice(2, 6)),
      [
        ['Environment', '${Environment}', 'Lane', 'normal'],
        ['Environment', '${Environment}', 'Lane', 'critical']
      ]
    );
    assert.equal(
      metrics.filter(
        (metric) => metric[1] === 'ApproximateNumberOfMessagesVisible'
      ).length,
      5
    );
    for (const name of [
      'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesDelayed',
      'ApproximateAgeOfOldestMessage'
    ]) {
      assert.equal(metrics.filter((metric) => metric[1] === name).length, 2);
    }
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('FILL('), false);
    assert.ok(serialized.includes('IF(requests>0,100*errors/requests)'));
    assert.ok(serialized.includes('not successful application jobs'));
    assert.ok(serialized.includes('Missing data is unknown'));
    assert.equal(serialized.includes('Invocations'), false);
    for (const [index, widget] of body.widgets.entries()) {
      assert.ok(widget.x >= 0 && widget.x + widget.width <= 24);
      for (const other of body.widgets.slice(index + 1)) {
        assert.ok(
          widget.x + widget.width <= other.x ||
            other.x + other.width <= widget.x ||
            widget.y + widget.height <= other.y ||
            other.y + other.height <= widget.y
        );
      }
    }
  }
});
