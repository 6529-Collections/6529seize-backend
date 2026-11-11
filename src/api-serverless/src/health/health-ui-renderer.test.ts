import { HealthData } from './health.service';
import { renderHealthUI } from './health-ui.renderer';

function buildHealthData(healthy: boolean): HealthData {
  return {
    status: healthy ? 'ok' : 'degraded',
    version: {
      commit: 'commit',
      node_env: 'test'
    },
    links: {
      api_documentation: '/docs',
      health_ui: '/health/ui',
      deploy_ui: '/deploy/ui'
    },
    db: 'ok',
    redis: {
      enabled: true,
      healthy: true
    },
    rate_limit: {
      enabled: true
    },
    arweave: {
      healthy: true
    },
    ipfs: {
      healthy
    }
  };
}

describe('health UI IPFS status', () => {
  it.each([
    { healthy: true, statusClass: 'status-ok', statusText: 'Healthy' },
    {
      healthy: false,
      statusClass: 'status-degraded',
      statusText: 'Degraded'
    }
  ])(
    'renders $statusText when healthy is $healthy',
    ({ healthy, statusClass, statusText }) => {
      const html = renderHealthUI(buildHealthData(healthy));

      expect(html).toContain('<td><strong>IPFS</strong></td>');
      expect(html).toContain(
        `<span class="status-badge ${statusClass}">${statusText}</span>`
      );
    }
  );
});

describe('health UI base URL', () => {
  it('escapes the request-derived base URL', () => {
    const html = renderHealthUI(
      buildHealthData(true),
      'https://api.6529.io"><script>x</script>'
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain(
      'content="https://api.6529.io&quot;&gt;&lt;script&gt;x&lt;/script&gt;/health/ui"'
    );
  });

  it('keeps a normal base URL unchanged', () => {
    expect(
      renderHealthUI(buildHealthData(true), 'https://api.6529.io')
    ).toContain(
      '<meta property="og:url" content="https://api.6529.io/health/ui">'
    );
  });
});
