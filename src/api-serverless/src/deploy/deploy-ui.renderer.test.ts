import { renderDeployUiApp } from '@/api/deploy/deploy-ui.renderer';

describe('deploy-ui.renderer', () => {
  it('recomputes deploy readiness when the target changes', () => {
    const app = renderDeployUiApp();

    expect(app).toContain('syncTargetSpecificControls();');
    expect(app).toContain('applyEnvironmentFilter();');
  });

  it('updates the workflow link when the target changes', () => {
    const app = renderDeployUiApp();

    expect(app).toContain('function getCurrentWorkflowUrl() {');
    expect(app).toContain(
      'https://github.com/6529-Collections/6529seize-backend/actions/workflows/deploy.yml'
    );
    expect(app).toContain(
      'https://github.com/6529-Collections/6529seize-frontend/actions/workflows/build-upload-deploy-prod.yml'
    );
    expect(app).toContain(
      'var urls = Object.assign({}, DEFAULT_WORKFLOW_URLS, (bootstrap && bootstrap.workflow_urls) || {});'
    );
    expect(app).toContain('return urls[state.deployTarget] || urls.backend;');
    expect(app).toContain(
      "deployWorkflowLink.setAttribute('href', getCurrentWorkflowUrl());"
    );
  });

  it('recomputes deploy readiness when the ref changes', () => {
    const app = renderDeployUiApp();

    expect(app).toContain('function applyRefSelection(option) {');
    expect(app).toContain('refInput.value = option.name;');
    expect(app).toContain('setCurrentRef(option.name);');
    expect(app).toContain('setRefMenuOpen(false);');
    expect(app).toContain('updateSelectedSummary();');

    expect(app).toContain("refInput.addEventListener('input', function () {");
    expect(app).toContain("setCurrentRef((refInput.value || '').trim());");
    expect(app).toContain('queueRefSearch();');

    expect(app).toContain('quickRefButtons.forEach(function (button) {');
    expect(app).toContain(
      "refInput.value = button.getAttribute('data-quick-ref') || '';"
    );
    expect(app).toContain('setCurrentRef(refInput.value);');
  });
});
