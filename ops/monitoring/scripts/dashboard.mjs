import { readFile, writeFile } from 'node:fs/promises';

const namespace = '6529/OperationalMonitoring';
const environment = '${Environment}';
const monitoring = { accountId: '${AWS::AccountId}', region: '${AWS::Region}' };
const source = { accountId: '${SourceAccountId}', region: '${SourceRegion}' };
const parameter = (description, pattern, extra = {}) => ({
  Type: 'String',
  Description: description,
  AllowedPattern: pattern,
  ...extra
});

function dashboard(environmentName) {
  const widgets = [];
  let y = 0;
  const text = (markdown) => {
    widgets.push({
      type: 'text',
      x: 0,
      y,
      width: 24,
      height: 3,
      properties: { markdown }
    });
    y += 3;
  };
  const row = (left, right) => {
    for (const [index, properties] of [left, right].entries()) {
      widgets.push({
        type: 'metric',
        x: index * 12,
        y,
        width: 12,
        height: 6,
        properties: {
          view: 'timeSeries',
          stacked: false,
          period: 60,
          stat: 'Sum',
          ...monitoring,
          legend: { position: 'bottom' },
          liveData: false,
          ...properties
        }
      });
    }
    y += 6;
  };
  const custom = (name, extra = [], options = {}) => [
    namespace,
    name,
    'Environment',
    environment,
    ...extra,
    options
  ];
  const probes = (metric, multiplier = '', stat = 'Average') => [
    [
      {
        expression: `${multiplier}SEARCH('{${namespace},Environment,Target} MetricName="${metric}" Environment="${environment}"', '${stat}', 60)`,
        id: 'observations'
      }
    ]
  ];
  const queue = (name, metric, options = {}) => [
    'AWS/SQS',
    metric,
    'QueueName',
    name,
    { stat: 'Maximum', ...options }
  ];
  const laneQueue = (lane) => `seize-monitoring-${environment}-${lane}`;
  text(
    `# ${environmentName.toUpperCase()} operational health\nMissing data is unknown, not healthy. Synthetic checks originate in the monitoring region. Pipeline heartbeats confirm queue/dispatcher progress, not successful application jobs.`
  );
  row(
    {
      title: 'Alert pipeline heartbeat age (seconds)',
      metrics: ['normal', 'critical'].map((lane) =>
        custom('HeartbeatAge', ['Lane', lane], { stat: 'Maximum', label: lane })
      ),
      annotations: {
        horizontal: [{ label: 'Freshness limit', value: 180, color: '#d62728' }]
      },
      yAxis: { left: { min: 0 } }
    },
    {
      title: 'Endpoint probe success (% of measured attempts)',
      metrics: probes('ProbeSuccess', '100 * '),
      yAxis: { left: { min: 0, max: 100 } }
    }
  );
  row(
    {
      title:
        'Synthetic probe elapsed time (milliseconds, includes assertions/timeouts)',
      metrics: probes('ProbeDurationMilliseconds'),
      yAxis: { left: { min: 0 } }
    },
    {
      title: 'Probe failures and scheduled probe execution errors',
      metrics: [
        ...probes('ProbeFailure', '', 'Sum'),
        [
          'AWS/Lambda',
          'Errors',
          'FunctionName',
          '${ProbeFunctionName}',
          { label: 'Probe Lambda errors' }
        ],
        [
          'AWS/Lambda',
          'Throttles',
          'FunctionName',
          '${ProbeFunctionName}',
          { label: 'Probe Lambda throttles' }
        ]
      ],
      yAxis: { left: { min: 0 } }
    }
  );
  row(
    {
      title: 'Oldest queued alert (seconds)',
      metrics: ['normal', 'critical'].map((lane) =>
        queue(laneQueue(lane), 'ApproximateAgeOfOldestMessage', { label: lane })
      ),
      annotations: {
        horizontal: [
          { label: 'Critical lane limit', value: 120 },
          { label: 'Normal lane limit', value: 600 }
        ]
      },
      yAxis: { left: { min: 0 } }
    },
    {
      title: 'Alert queue backlog (visible, in flight and delayed)',
      metrics: ['normal', 'critical'].flatMap((lane) =>
        [
          ['ApproximateNumberOfMessagesVisible', 'visible'],
          ['ApproximateNumberOfMessagesNotVisible', 'in flight'],
          ['ApproximateNumberOfMessagesDelayed', 'delayed']
        ].map(([metric, state]) =>
          queue(laneQueue(lane), metric, { label: `${lane}: ${state}` })
        )
      ),
      yAxis: { left: { min: 0 } }
    }
  );
  row(
    {
      title: 'Dead-letter queue backlog (pending archive)',
      metrics: ['Normal', 'Critical', 'Event'].map((lane) =>
        queue(
          '${' + lane + 'DeadLettersName}',
          'ApproximateNumberOfMessagesVisible',
          { label: lane }
        )
      ),
      yAxis: { left: { min: 0 } }
    },
    {
      title: 'Delivery failures and admission overflow (events/minute)',
      metrics: [
        custom('DeliveryFailures'),
        custom('AdmissionOverflow'),
        custom('ProbeMetricPublicationFailures')
      ],
      yAxis: { left: { min: 0 } }
    }
  );
  text(
    '## Actual API requests — source account / region\nREST API metrics include API Gateway overhead and backend integration time separately. No requests or missing telemetry leave gaps; graphs do not substitute successful samples.'
  );
  const api = (name, options = {}) => [
    'AWS/ApiGateway',
    name,
    'ApiName',
    '${RestApiName}',
    'Stage',
    '${RestApiStage}',
    { ...source, ...options }
  ];
  row(
    {
      ...source,
      title: 'REST API request latency (milliseconds)',
      metrics: ['p50', 'p95', 'p99'].map((stat) =>
        api('Latency', { stat, label: `API ${stat}` })
      ),
      yAxis: { left: { min: 0 } }
    },
    {
      ...source,
      title: 'REST API backend integration latency (milliseconds)',
      metrics: ['p50', 'p95', 'p99'].map((stat) =>
        api('IntegrationLatency', { stat, label: `Integration ${stat}` })
      ),
      yAxis: { left: { min: 0 } }
    }
  );
  row(
    {
      ...source,
      title: 'REST API server error rate (%)',
      metrics: [
        api('Count', { id: 'requests', stat: 'SampleCount', visible: false }),
        api('5XXError', { id: 'errors', stat: 'Sum', visible: false }),
        [
          {
            expression: 'IF(requests>0,100*errors/requests)',
            id: 'rate',
            label: 'API 5xx / requests'
          }
        ]
      ],
      yAxis: { left: { min: 0, max: 100 } }
    },
    {
      ...source,
      title: 'REST API request and server error counts (per minute)',
      metrics: [
        api('Count', { stat: 'SampleCount', label: 'Requests' }),
        api('5XXError', { stat: 'Sum', label: 'Server errors' })
      ],
      yAxis: { left: { min: 0 } }
    }
  );
  if (environmentName === 'prod') {
    text(
      '## Actual website requests — application load balancer\nTarget response time measures time to response headers, not page rendering. Target 5xx rate excludes requests rejected before target selection; load-balancer errors and target health are separate signals.'
    );
    const alb = (name, options = {}, target = true) => [
      'AWS/ApplicationELB',
      name,
      'LoadBalancer',
      '${WebsiteLoadBalancer}',
      ...(target ? ['TargetGroup', '${WebsiteTargetGroup}'] : []),
      { ...source, ...options }
    ];
    row(
      {
        ...source,
        title: 'Website target response time (seconds)',
        metrics: ['p50', 'p95', 'p99'].map((stat) =>
          alb('TargetResponseTime', { stat, label: `Target ${stat}` })
        ),
        yAxis: { left: { min: 0 } }
      },
      {
        ...source,
        title: 'Website target server error rate (%)',
        metrics: [
          alb('RequestCount', { id: 'requests', stat: 'Sum', visible: false }),
          alb('HTTPCode_Target_5XX_Count', {
            id: 'errors',
            stat: 'Sum',
            visible: false
          }),
          [
            {
              expression: 'IF(requests>0,100*errors/requests)',
              id: 'rate',
              label: 'Target 5xx / routed requests'
            }
          ]
        ],
        yAxis: { left: { min: 0, max: 100 } }
      }
    );
    row(
      {
        ...source,
        title:
          'Website routed requests and pre-target server errors (per minute)',
        metrics: [
          alb('RequestCount', { stat: 'Sum', label: 'Routed requests' }),
          alb(
            'HTTPCode_ELB_5XX_Count',
            { stat: 'Sum', label: 'Load balancer 5xx' },
            false
          )
        ],
        yAxis: { left: { min: 0 } }
      },
      {
        ...source,
        title: 'Website unhealthy targets',
        metrics: [
          alb('UnHealthyHostCount', {
            stat: 'Maximum',
            label: 'Maximum across load balancer nodes'
          }),
          alb('HealthyHostCount', {
            stat: 'Minimum',
            label: 'Minimum healthy targets'
          })
        ],
        yAxis: { left: { min: 0 } }
      }
    );
  } else {
    text(
      '## Staging website request telemetry gap\nThis environment does not use the production application load balancer. Synthetic endpoint checks are available above; native website request latency/error rate is not configured and is not inferred from those checks.'
    );
  }
  text(
    '## Interpretation and investigation\nA failed/missing probe, rising lane age, backlog, or delivery failure needs investigation. Dead letters are archived, so a drained queue does not erase failures. This dashboard does not establish business-job completion or protect against AWS-wide failures. Use the monitoring runbook and source account alarms for diagnosis.'
  );
  return { start: '-PT6H', periodOverride: 'inherit', widgets };
}

function template(environmentName) {
  const parameters = {
    Environment: {
      Type: 'String',
      AllowedValues: [environmentName],
      Default: environmentName
    },
    SourceAccountId: parameter(
      'Verified application account owning the native metrics.',
      String.raw`^\d{12}$`
    ),
    SourceRegion: parameter(
      'Verified region of the application API and website metrics.',
      String.raw`^[a-z]{2}(-gov)?-[a-z]+-\d$`
    ),
    RestApiName: parameter(
      'Exact observed AWS/ApiGateway ApiName dimension; not the API ID.',
      '^[A-Za-z0-9 ._-]{1,128}$'
    ),
    RestApiStage: parameter(
      'Exact observed REST API Stage dimension.',
      '^[A-Za-z0-9_-]{1,128}$'
    ),
    ProbeFunctionName: parameter(
      'Physical Probe Lambda name from the monitoring stack.',
      '^seize-monitoring-' + environmentName + '-[A-Za-z0-9_-]{1,64}$'
    ),
    ...Object.fromEntries(
      ['Normal', 'Critical', 'Event'].map((lane) => [
        lane + 'DeadLettersName',
        parameter(
          'Physical ' +
            lane +
            'DeadLetters queue name from the monitoring stack.',
          '^seize-monitoring-' + environmentName + '-[A-Za-z0-9_-]{1,80}$'
        )
      ])
    )
  };
  if (environmentName === 'prod') {
    parameters.WebsiteLoadBalancer = parameter(
      'Verified full LoadBalancer dimension (app/name/id), never its ARN.',
      '^app/[A-Za-z0-9-]+/[a-f0-9]+$'
    );
    parameters.WebsiteTargetGroup = parameter(
      'Verified full TargetGroup dimension, never its ARN.',
      '^targetgroup/[A-Za-z0-9-]+/[a-f0-9]+$'
    );
  }
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Operational health and verified source request metrics; deploy in the monitoring account after cross-account console sharing.',
    Parameters: parameters,
    Resources: {
      Dashboard: {
        Type: 'AWS::CloudWatch::Dashboard',
        Properties: {
          DashboardName: {
            'Fn::Sub': 'seize-monitoring-${Environment}-health'
          },
          DashboardBody: {
            'Fn::Sub': JSON.stringify(dashboard(environmentName))
          }
        }
      }
    },
    Outputs: { DashboardName: { Value: { Ref: 'Dashboard' } } }
  };
}

for (const environmentName of ['prod', 'staging']) {
  const path = new URL(`../dashboard-${environmentName}.json`, import.meta.url);
  const content = JSON.stringify(template(environmentName), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== content)
      throw new Error('STALE_DASHBOARD_TEMPLATE');
  } else await writeFile(path, content);
}
