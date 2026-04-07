import { renderDeployUiApp } from '@/api/deploy/deploy-ui.renderer';

describe('deploy-ui.renderer', () => {
  it('recomputes deploy readiness when the target changes', () => {
    const app = renderDeployUiApp();

    expect(app).toContain('syncTargetSpecificControls();');
    expect(app).toContain('applyEnvironmentFilter();');
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

  it('treats startup failure runs as failed status badges', () => {
    const app = renderDeployUiApp();

    expect(app).toContain('var outcomeKey = String(outcome).toLowerCase();');
    expect(app).toContain("outcomeKey === 'startup_failure'");
    expect(app).toContain(
      "statusNode.className = 'run-status ' + outcomeClass;"
    );
  });
});
