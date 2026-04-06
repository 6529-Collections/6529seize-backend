import { renderDeployUiApp } from '@/api/deploy/deploy-ui.renderer';

describe('deploy-ui.renderer', () => {
  it('recomputes deploy readiness when the target changes', () => {
    const app = renderDeployUiApp();

    expect(app).toContain(
      'syncTargetSpecificControls();\n      applyEnvironmentFilter();'
    );
  });

  it('recomputes deploy readiness when the ref changes', () => {
    const app = renderDeployUiApp();

    expect(app).toContain(
      '  function applyRefSelection(option) {\n    refInput.value = option.name;\n    setCurrentRef(option.name);\n    state.refActiveIndex = -1;\n    setRefMenuOpen(false);\n    updateSelectedSummary();\n  }'
    );
    expect(app).toContain(
      "  refInput.addEventListener('input', function () {\n    setCurrentRef((refInput.value || '').trim());\n    queueRefSearch();\n    updateSelectedSummary();\n  });"
    );
    expect(app).toContain(
      "  quickRefButtons.forEach(function (button) {\n    button.addEventListener('click', function () {\n      refInput.value = button.getAttribute('data-quick-ref') || '';\n      setCurrentRef(refInput.value);\n      setRefMenuOpen(false);\n      updateSelectedSummary();\n    });\n  });"
    );
  });
});
