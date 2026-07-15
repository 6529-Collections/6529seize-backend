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
    expect(html).toContain('Operator controls');
    expect(html).toContain('Pause all');
  });

  it('resolves a branch head before submitting and escapes server values', () => {
    const app = renderDeployBusUiApp();

    expect(app).toContain("request('/deploy/ui/branch-head?");
    expect(app).toContain("request('/deploy/release-candidates/ready'");
    expect(app).toContain('replace(/[&<>"\']/g');
    expect(app).toContain('expected_head_sha:');
  });
});
