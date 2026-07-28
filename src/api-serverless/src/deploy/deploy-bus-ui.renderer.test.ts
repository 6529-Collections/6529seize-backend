import {
  renderDeployBusUI,
  renderDeployBusUiApp
} from '@/api/deploy/deploy-bus-ui.renderer';

describe('deploy-bus-ui.renderer', () => {
  it('renders separate staging and explicit production queues', () => {
    const html = renderDeployBusUI();

    expect(html).toContain('Register exact green PR for staging');
    expect(html).toContain('id="staging-candidates"');
    expect(html).toContain('id="production-candidates"');
    expect(html).toContain('successful staging E2E evidence');
    expect(html).toContain('STAGING_DEPLOYED is distinct');
    expect(html).toContain('Mark selected for production');
    expect(html).toContain('Operator controls');
    expect(html).toContain('Pause all');
    expect(html).toContain('Active staging and production work');
    expect(html).toContain('Legacy exact-manifest qualification records');
    expect(html).toContain('id="active-trains"');
    expect(html).toContain('Exact manifests');
    expect(html).toContain('Runtime and environment ownership');
    expect(html).toContain('dashboard below is public');
    expect(html).toContain('Connect as operator (optional)');
    expect(html).toContain('id="dashboard" class="stack"');
    expect(html).toContain('id="dashboard-status"');
  });

  it('resolves a branch head before submitting and escapes server values', () => {
    const app = renderDeployBusUiApp();

    expect(app).toContain("request('/deploy/ui/branch-head?");
    expect(app).toContain("request('/deploy/release-bus-v2/candidates'");
    expect(app).toContain('replace(/[&<>"\']/g');
    expect(app).toContain('expected_head_sha:');
    expect(app).toContain('pr_number:');
    expect(app).toContain('/release-bus-v2/production-selections');
    expect(app).toContain('data-select-production');
    expect(app).toContain('revoke-production-readiness');
    expect(app).toContain("data.mode==='OFF'");
    expect(app).toContain('item.reason');
    expect(app).toContain('function renderRuntime');
    expect(app).toContain('function renderTrainDetail');
    expect(app).toContain('function renderOperation');
    expect(app).toContain('function renderManifests');
    expect(app).toContain("request('/deploy/release-bus-v2/trains/'");
    expect(app).toContain('Candidate isolation is not applied');
    expect(app).toContain('awaiting structured terminal reconciliation');
    expect(app).toContain("item.status==='STAGING_DEPLOYED'");
    expect(app).toContain("item.status==='STAGING_VALIDATED'");
    expect(app).toContain('Production remains explicit');
    expect(app).toContain('failure_message');
    expect(app).toContain('artifact_digest');
    expect(app).toContain('current-live manifest');
    expect(app).toContain('Authoritative shared staging');
    expect(app).toContain('CURRENT STAGING PRESENCE UNKNOWN');
    expect(app).toContain(
      "if(state.token)result.Authorization='Bearer '+state.token"
    );
    expect(app).toContain('var actions=state.operator?');
    expect(app).toContain('setOperator(false);refresh().catch(function(error)');
    expect(app).toContain('Public read-only access remains available');
    expect(app).not.toContain("byId('authenticated')");
    expect(app).toContain("if(register)register.disabled=data.mode==='OFF'");
    expect(app).toContain("if(reconcile)reconcile.disabled=data.mode==='OFF'");
  });
});
