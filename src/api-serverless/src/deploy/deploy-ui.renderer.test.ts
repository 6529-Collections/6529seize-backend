import { runInNewContext } from 'node:vm';
import {
  renderDeployUI,
  renderDeployUiApp
} from '@/api/deploy/deploy-ui.renderer';
import { getDeployServiceConfigs } from '@/api/deploy/deploy.config';

type UiEvent = { preventDefault: () => void; stopPropagation: () => void };

class UiElement {
  value = '';
  checked = false;
  disabled = false;
  textContent = '';
  innerHTML = '';
  style = {};
  input: UiElement | null = null;
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, (event: UiEvent) => unknown>();
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, enabled: boolean) =>
      enabled ? this.classes.add(name) : this.classes.delete(name)
  };

  constructor(private readonly attributes: Record<string, string> = {}) {}

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  querySelector() {
    return this.input;
  }
  appendChild() {}
  addEventListener(type: string, listener: (event: UiEvent) => unknown) {
    this.listeners.set(type, listener);
  }
  async emit(type: string) {
    await this.listeners.get(type)?.({
      preventDefault: jest.fn(),
      stopPropagation: jest.fn()
    });
  }
}

function mountApp(defaultEnvironment: 'staging' | 'prod' = 'staging') {
  const elements = new Map<string, UiElement>();
  function element(id: string): UiElement {
    const existing = elements.get(id);
    if (existing) return existing;
    const created = new UiElement();
    elements.set(id, created);
    return created;
  }
  element('deploy-ui-bootstrap').textContent = JSON.stringify({
    default_environment: defaultEnvironment
  });
  const targetButtons = ['backend', 'frontend'].map(
    (target) => new UiElement({ 'data-deploy-target': target })
  );
  const environmentButtons = ['staging', 'prod'].map(
    (environment) => new UiElement({ 'data-environment': environment })
  );
  const cards = ['api', 'dbMigrationsLoop'].map((name) => {
    const card = new UiElement({
      'data-service-name': name,
      'data-environments': 'staging,prod'
    });
    card.input = new UiElement();
    return card;
  });
  const selectors: Record<string, UiElement[]> = {
    '[data-deploy-target]': targetButtons,
    '[data-env-button]': environmentButtons,
    '[data-service-card]': cards
  };
  const fetch = jest.fn(async (_url: string, _options?: { body?: string }) => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        login: 'developer',
        results: [],
        summary: { failed: 0 }
      })
  }));
  runInNewContext(renderDeployUiApp(), {
    document: {
      getElementById: element,
      querySelector: () => element('services-panel'),
      querySelectorAll: (selector: string) => selectors[selector] ?? [],
      createElement: () => new UiElement(),
      createTextNode: () => new UiElement(),
      addEventListener: jest.fn()
    },
    localStorage: {
      getItem: () => '',
      setItem: jest.fn(),
      removeItem: jest.fn()
    },
    window: {
      location: { origin: 'https://example.test' },
      setTimeout: jest.fn(),
      setInterval: jest.fn()
    },
    clearInterval: jest.fn(),
    clearTimeout: jest.fn(),
    URL,
    fetch
  });

  return {
    element,
    cards,
    targetButtons,
    environmentButtons,
    async authenticate() {
      element('token-input').value = 'test-token';
      await element('connect-button').emit('click');
    },
    dispatchedBody() {
      const dispatch = fetch.mock.calls.find(
        ([url]) => url === '/deploy/ui/dispatch'
      );
      expect(dispatch).toBeDefined();
      return JSON.parse(dispatch?.[1]?.body ?? '{}') as Record<string, unknown>;
    }
  };
}

describe('deploy-ui.renderer', () => {
  it.each([
    ['staging', '1a-staging'],
    ['prod', 'main']
  ] as const)('starts %s on its deployment branch %s', (environment, ref) => {
    const app = mountApp(environment);

    expect(app.element('ref-input').value).toBe(ref);
    expect(
      app.element('release-note-fields').classList.contains('hidden')
    ).toBe(environment === 'staging');
  });

  it('switches the branch and release-note controls with the environment', async () => {
    const app = mountApp();

    await app.environmentButtons[1].emit('click');
    expect(app.element('ref-input').value).toBe('main');
    expect(
      app.element('release-note-fields').classList.contains('hidden')
    ).toBe(false);
    expect(
      app.element('backend-release-note-fields').classList.contains('hidden')
    ).toBe(false);

    await app.environmentButtons[0].emit('click');
    expect(app.element('ref-input').value).toBe('1a-staging');
    expect(
      app.element('release-note-fields').classList.contains('hidden')
    ).toBe(true);
    expect(app.element('release-note-opt-out').disabled).toBe(true);
  });

  it('shows and sends only the production opt-out for frontend', async () => {
    const app = mountApp('prod');
    await app.authenticate();
    app.element('release-pull-request').value = '1801';
    app.element('release-group-services').value = 'dbMigrationsLoop,api';
    app.element('release-note-opt-out').checked = true;

    await app.targetButtons[1].emit('click');
    expect(
      app.element('release-note-fields').classList.contains('hidden')
    ).toBe(false);
    expect(
      app.element('backend-release-note-fields').classList.contains('hidden')
    ).toBe(true);
    expect(app.element('release-pull-request').disabled).toBe(true);
    expect(app.element('release-note-opt-out').disabled).toBe(false);
    await app.element('deploy-button').emit('click');

    expect(app.dispatchedBody()).toEqual({
      target: 'frontend',
      ref: 'main',
      environment: 'prod',
      release_note_opt_out: true
    });
  });

  it('sends backend production PR and service-group metadata', async () => {
    const app = mountApp('prod');
    await app.authenticate();
    await app.cards[0].emit('click');
    app.element('release-pull-request').value = '1801';
    app.element('release-group-services').value = 'dbMigrationsLoop,api';

    await app.element('deploy-button').emit('click');

    expect(app.dispatchedBody()).toEqual({
      target: 'backend',
      ref: 'main',
      environment: 'prod',
      services: ['api'],
      release_pull_request: 1801,
      release_group_services: 'dbMigrationsLoop,api',
      release_note_opt_out: false
    });
  });

  it('disables and omits retained backend PR inputs for internal production', async () => {
    const app = mountApp('prod');
    await app.authenticate();
    await app.cards[0].emit('click');
    app.element('release-pull-request').value = '1801';
    app.element('release-group-services').value = 'api';
    app.element('release-note-opt-out').checked = true;
    await app.element('release-note-opt-out').emit('change');

    expect(app.element('release-pull-request').disabled).toBe(true);
    expect(app.element('release-group-services').disabled).toBe(true);
    await app.element('deploy-button').emit('click');
    expect(app.dispatchedBody()).toEqual({
      target: 'backend',
      ref: 'main',
      environment: 'prod',
      services: ['api'],
      release_note_opt_out: true
    });
  });

  it('omits all production fields when switching back to staging', async () => {
    const app = mountApp('prod');
    await app.authenticate();
    await app.cards[0].emit('click');
    app.element('release-pull-request').value = '1801';
    app.element('release-group-services').value = 'api';
    app.element('release-note-opt-out').checked = true;

    await app.environmentButtons[0].emit('click');
    await app.element('deploy-button').emit('click');

    expect(app.dispatchedBody()).toEqual({
      target: 'backend',
      ref: '1a-staging',
      environment: 'staging',
      services: ['api']
    });
  });

  it('allows one service selection and selects only the first visible service', async () => {
    const app = mountApp();
    await app.authenticate();
    await app.cards[0].emit('click');
    await app.cards[1].emit('click');
    expect(app.cards.map((card) => card.input?.checked)).toEqual([false, true]);

    await app.element('select-visible-button').emit('click');
    expect(app.cards.map((card) => card.input?.checked)).toEqual([true, false]);
    expect(app.element('deploy-button').disabled).toBe(false);
    await app.element('clear-selection-button').emit('click');
    expect(app.cards.map((card) => card.input?.checked)).toEqual([
      false,
      false
    ]);
    expect(app.element('deploy-button').disabled).toBe(true);
  });

  it('renders the release-note containers and native single-service inputs', () => {
    const html = renderDeployUI(getDeployServiceConfigs());
    expect(html).toContain('id="release-note-fields"');
    expect(html).toContain('id="backend-release-note-fields"');
    expect(html).toContain('type="radio" name="backend-deploy-service"');
    expect(html).toContain('>Deploy service</button>');
  });

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
