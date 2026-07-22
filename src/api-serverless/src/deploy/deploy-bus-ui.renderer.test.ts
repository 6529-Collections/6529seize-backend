import {
  renderDeployBusUI,
  renderDeployBusUiApp
} from '@/api/deploy/deploy-bus-ui.renderer';

describe('deploy-bus-ui.renderer', () => {
  it('renders separate immutable staging and production readiness controls', () => {
    const html = renderDeployBusUI();

    expect(html).toContain('Mark exact SHA ready');
    expect(html).toContain('<option value="STAGING">Staging</option>');
    expect(html).toContain('<option value="PRODUCTION">Production</option>');
    expect(html).toContain('id="mark-ready"');
    expect(html).toContain('type="submit" disabled');
    expect(html).toContain('Operator controls');
    expect(html).toContain('Pause all');
    expect(html).toContain('Active train');
    expect(html).toContain('id="active-train"');
    expect(html).toContain('id="force-fresh-base-canary"');
    expect(html).toContain('Current phase, exact wait, workflow progress');
  });

  it('resolves a branch head before submitting and escapes server values', () => {
    const app = renderDeployBusUiApp();

    expect(app).toContain("request('/deploy/ui/branch-head?");
    expect(app).toContain("request('/deploy/release-candidates/ready'");
    expect(app).toContain('replace(/[&<>"\']/g');
    expect(app).toContain('expected_head_sha:');
    expect(app).toContain('force_fresh_base_canary:');
    expect(app).toContain('Fresh base canary required');
    expect(app).toContain("state.mode==='OFF'");
    expect(app).toContain("state.mode==='STAGING'&&lane==='PRODUCTION'");
    expect(app).toContain('SHADOW records decisions only');
    expect(app).toContain('item.reason');
    expect(app).toContain('item.github_actor');
    expect(app).toContain('Open failure evidence');
    expect(app).toContain("item.github_actor==='release-bus-worker'");
    expect(app).toContain(
      'github[.]com/6529-Collections/6529seize-(?:frontend|backend)'
    );
    expect(app).toContain('function safeActionUrl');
    expect(app).toContain('function renderOverview');
    expect(app).toContain('function renderIncident');
    expect(app).toContain('function renderOperation');
    expect(app).toContain('function renderTimeline');
    expect(app).toContain('results[1].active_train');
    expect(app).toContain("request('/deploy/release-trains/'");
    expect(app).toContain('Open GitHub Actions run');
    expect(app).toContain('esc(incident.summary)');
    expect(app).toContain('esc(operation.active_job');
    expect(app).toContain('SUPERSEDED_BY_UNREGISTERED_HEAD');
    expect(app).toContain('Historical immutable SHA');
    expect(app).toContain('item.current_phase');
    expect(app).toContain('item.phase_state');
    expect(app).toContain('incident.retry_state');
    expect(app).not.toContain('href="\'+operation.workflow_url');
  });
});
