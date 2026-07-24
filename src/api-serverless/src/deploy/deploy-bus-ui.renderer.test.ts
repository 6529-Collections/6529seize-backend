import {
  renderDeployBusUI,
  renderDeployBusUiApp
} from '@/api/deploy/deploy-bus-ui.renderer';
import { runInNewContext } from 'node:vm';

interface FakeClassList {
  contains(name: string): boolean;
  toggle(name: string, force?: boolean): boolean;
}

interface FakeElement {
  classList: FakeClassList;
  className: string;
  dataset: Record<string, string>;
  disabled: boolean;
  focus(): void;
  innerHTML: string;
  onchange?: () => unknown;
  onclick?: () => unknown;
  onsubmit?: (event: { preventDefault(): void }) => unknown;
  textContent: string;
  value: string;
}

interface AppHarness {
  document: {
    activeElement: FakeElement | null;
  };
  elements: Record<string, FakeElement>;
  localStorage: {
    getItem(key: string): string | null;
  };
}

function createClassList(initial: string[] = []): FakeClassList {
  const names = new Set(initial);
  return {
    contains: (name) => names.has(name),
    toggle: (name, force) => {
      const shouldAdd = force ?? !names.has(name);
      if (shouldAdd) {
        names.add(name);
      } else {
        names.delete(name);
      }
      return shouldAdd;
    }
  };
}

function createAppHarness({
  storedToken,
  sessionError,
  refreshError
}: {
  storedToken?: string;
  sessionError?: string;
  refreshError?: string;
} = {}): AppHarness {
  const elements: Record<string, FakeElement> = {};
  const document = {
    activeElement: null as FakeElement | null,
    getElementById: (id: string) => {
      if (!elements[id]) {
        const classList = createClassList(
          ['authenticated', 'forget', 'backend-plan'].includes(id)
            ? ['hidden']
            : []
        );
        const element: FakeElement = {
          classList,
          className: '',
          dataset: {},
          disabled: false,
          focus: () => {
            document.activeElement = element;
          },
          innerHTML: '',
          textContent: '',
          value: ''
        };
        elements[id] = element;
      }
      return elements[id];
    },
    querySelectorAll: () => []
  };

  document.getElementById('authentication');
  document.getElementById('authenticated');
  document.getElementById('manifests');
  document.getElementById('token');
  document.getElementById('repository').value = 'frontend';

  const storage = new Map<string, string>();
  if (storedToken) {
    storage.set('deploy-ui-token', storedToken);
  }
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value)
  };

  const fetch = async (url: string) => {
    if (url === '/deploy/ui/session' && sessionError) {
      throw new Error(sessionError);
    }
    if (url.startsWith('/deploy/release-bus-v2/candidates') && refreshError) {
      throw new Error(refreshError);
    }
    const responses: Record<string, object> = {
      '/deploy/ui/session': { login: 'GelatoGenesis' },
      '/deploy/release-bus-v2/trains': { trains: [] },
      '/deploy/release-bus-v2/manifests': { manifests: [] },
      '/deploy/release-bus-v2/controls': {
        mode: 'PRODUCTION',
        controls: [],
        locks: []
      }
    };
    const payload = url.startsWith('/deploy/release-bus-v2/candidates')
      ? { candidates: [] }
      : responses[url];
    if (!payload) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return {
      json: async () => payload,
      ok: true,
      status: 200
    };
  };

  runInNewContext(renderDeployBusUiApp(), {
    document,
    fetch,
    localStorage
  });

  return { document, elements, localStorage };
}

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
    expect(html).toContain(
      '<button id="forget" type="button" class="hidden">Forget token</button>'
    );
    expect(html).toContain(
      '<section id="authentication" class="panel" aria-labelledby="authentication-heading">'
    );
    expect(html).toContain(
      '<div class="actions"><button id="connect" class="primary" type="button">Connect</button></div>'
    );
  });

  it('switches between logged-out authentication and logged-in controls', async () => {
    const harness = createAppHarness();

    expect(harness.elements.authentication.classList.contains('hidden')).toBe(
      false
    );
    expect(harness.elements.authenticated.classList.contains('hidden')).toBe(
      true
    );
    expect(harness.elements.forget.classList.contains('hidden')).toBe(true);

    harness.elements.token.value = 'valid-token';
    harness.document.activeElement = harness.elements.connect;
    await harness.elements.connect.onclick?.();

    expect(harness.elements.authentication.classList.contains('hidden')).toBe(
      true
    );
    expect(harness.elements.authenticated.classList.contains('hidden')).toBe(
      false
    );
    expect(harness.elements.forget.classList.contains('hidden')).toBe(false);
    expect(harness.elements.connect.disabled).toBe(false);
    expect(harness.elements.token.disabled).toBe(false);
    expect(harness.document.activeElement).toBe(harness.elements.forget);
    expect(harness.localStorage.getItem('deploy-ui-token')).toBe('valid-token');

    harness.elements.manifests.innerHTML = 'stale manifest';
    await harness.elements.forget.onclick?.();

    expect(harness.elements.authentication.classList.contains('hidden')).toBe(
      false
    );
    expect(harness.elements.authenticated.classList.contains('hidden')).toBe(
      true
    );
    expect(harness.elements.forget.classList.contains('hidden')).toBe(true);
    expect(harness.document.activeElement).toBe(harness.elements.token);
    expect(harness.localStorage.getItem('deploy-ui-token')).toBeNull();
    expect(harness.elements.manifests.innerHTML).toBe('');
  });

  it('clears a rejected stored token and explains how to recover', async () => {
    const harness = createAppHarness({
      storedToken: 'stale-token',
      sessionError: 'Bad credentials'
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.localStorage.getItem('deploy-ui-token')).toBeNull();
    expect(harness.elements.authentication.classList.contains('hidden')).toBe(
      false
    );
    expect(harness.elements.authenticated.classList.contains('hidden')).toBe(
      true
    );
    expect(harness.elements['auth-status'].textContent).toBe(
      'Stored token was rejected. Paste a new GitHub token.'
    );
    expect(harness.elements.connect.disabled).toBe(false);
    expect(harness.elements.token.disabled).toBe(false);
  });

  it('keeps a clean authenticated shell visible when refresh fails', async () => {
    const harness = createAppHarness({
      refreshError: 'Refresh failed'
    });
    harness.elements.manifests.innerHTML = 'stale manifest';
    harness.elements.token.value = 'valid-token';

    await harness.elements.connect.onclick?.();

    expect(harness.elements.authentication.classList.contains('hidden')).toBe(
      true
    );
    expect(harness.elements.authenticated.classList.contains('hidden')).toBe(
      false
    );
    expect(harness.elements.manifests.innerHTML).toBe('');
    expect(harness.elements['register-status'].textContent).toBe(
      'Refresh failed'
    );
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
