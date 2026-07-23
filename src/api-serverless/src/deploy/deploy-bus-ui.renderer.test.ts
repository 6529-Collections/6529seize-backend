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
    expect(html).toContain('Only exact STAGING_VALIDATED SHAs');
    expect(html).toContain('STAGING_DEPLOYED is visible');
    expect(html).toContain('Operator controls');
    expect(html).toContain('Pause all');
    expect(html).toContain(
      'Active staging, qualification, and production work'
    );
    expect(html).toContain('id="active-trains"');
    expect(html).toContain('Exact manifests');
    expect(html).toContain('Runtime and environment ownership');
  });

  it('resolves a branch head before submitting and escapes server values', () => {
    const app = renderDeployBusUiApp();

    expect(app).toContain("request('/deploy/ui/branch-head?");
    expect(app).toContain("request('/deploy/release-bus-v2/candidates'");
    expect(app).toContain('replace(/[&<>"\']/g');
    expect(app).toContain('expected_head_sha:');
    expect(app).toContain('pr_number:');
    expect(app).toContain('mark-ready-for-production');
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
  });
});
