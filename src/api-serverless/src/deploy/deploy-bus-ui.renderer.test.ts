import {
  renderDeployBusUI,
  renderDeployBusUiApp
} from '@/api/deploy/deploy-bus-ui.renderer';

describe('deploy-bus-ui.renderer', () => {
  it('renders compact authentication and exactly two environment blocks', () => {
    const html = renderDeployBusUI();
    const app = renderDeployBusUiApp();

    expect(html).toContain('<h1>Release Bus</h1>');
    expect(html).not.toContain('Release Bus v2');
    expect(html).not.toContain('Candidate-level staging evidence');
    expect(html).not.toContain('<h2>GitHub authentication</h2>');
    expect(html).toContain('id="show-auth"');
    expect(html).toContain('>Authenticate</button>');
    expect(html).toContain('id="auth-connected"');
    expect(html).toContain('>Forget Token</button>');
    expect(html).toContain('aria-label="Advanced deployment console"');
    expect(html).toContain('id="staging-environment"');
    expect(html).toContain('id="production-environment"');
    expect(html).toContain('id="staging-heading"');
    expect(html).toContain('id="production-heading"');
    expect(app).toContain("'Authenticated as '+login");
    expect(app).toContain("byId('auth-form').classList.add('hidden')");
    expect(app).toContain("byId('show-auth').onclick=showAuthenticationForm");
  });

  it('replaces the legacy dashboard sections with lane-focused train views', () => {
    const html = renderDeployBusUI();

    expect(html.match(/<h3>Current train<\/h3>/g)).toHaveLength(2);
    expect(html.match(/<h3>Next train if nothing changes<\/h3>/g)).toHaveLength(
      2
    );
    expect(html.match(/<h3>Previous trains<\/h3>/g)).toHaveLength(2);
    expect(html).toContain('id="staging-heads"');
    expect(html).toContain('id="production-heads"');
    expect(html).not.toContain('<h2>Staging queue</h2>');
    expect(html).not.toContain('<h2>Production queue</h2>');
    expect(html).not.toContain('Active staging and production work');
    expect(html).not.toContain('<h2>Recent trains</h2>');
    expect(html).not.toContain('<h2>Exact manifests</h2>');
    expect(html).not.toContain('Runtime and environment ownership');
    expect(html).not.toContain('Operator controls');
    expect(html).not.toContain('data-scope="ALL"');
    expect(html).not.toContain('id="refresh"');
    expect(html).not.toContain('id="reconcile"');
  });

  it('renders a filtered, incrementally paginated common PR view', () => {
    const html = renderDeployBusUI();
    const app = renderDeployBusUiApp();

    expect(html).toContain('<h2 id="pull-requests-heading">Pull requests</h2>');
    expect(html).toContain('id="pr-filter"');
    expect(html).toContain('id="status-filter"');
    expect(html).toContain('id="pull-requests"');
    expect(html).toContain('id="load-more-prs"');
    expect(html).toContain('>Load 10 more</button>');
    expect(html).toContain('<summary>Register another PR</summary>');
    expect(app).toContain('state.prVisible+=10');
    expect(app).toContain('state.previousVisible[lane]+=5');
    expect(app).toContain("Showing '+visible.length+' of '+filtered.length");
    expect(app).toContain("byId('pr-filter').oninput");
    expect(app).toContain("byId('status-filter').onchange");
  });

  it('shows exact train timing, repository groups, PR links, DAGs and diagnostics', () => {
    const app = renderDeployBusUiApp();

    expect(app).toContain("Started '+esc(dateTime(train.created_at))");
    expect(app).toContain(
      "Status since '+esc(dateTime(train.phase_started_at||train.updated_at))"
    );
    expect(app).toContain('repositoryGroups(candidates,data,false)');
    expect(app).toContain("['backend','frontend'].map");
    expect(app).toContain("'https://github.com/6529-Collections/6529seize-'");
    expect(app).toContain('<strong>DAG:</strong>');
    expect(app).toContain('candidate_role');
    expect(app).toContain('disposition');
    expect(app).toContain(
      '<details class="diagnostics"><summary>Diagnostics and immutable evidence</summary>'
    );
    expect(app).toContain('Open workflow');
    expect(app).toContain('function safeHttpsUrl(value)');
    expect(app).toContain('safeHttpsUrl(workflow&&workflow.html_url)||runUrl');
    expect(app).toContain('Durable events');
    expect(app).toContain('This mutable projection is not claim evidence');
    expect(app).toContain("candidate.status==='WAITING_FOR_PRODUCTION_REPLAN'");
    expect(app).toContain('if(replanning)');
    expect(app).toContain('(!activeId||candidate.current_train_id!==activeId)');
    expect(app).toContain('Production selection provenance is unavailable');
    expect(app).toContain('queued=ordered.slice(0,1)');
  });

  it('derives deployed and validated heads and keeps mutations authenticated', () => {
    const app = renderDeployBusUiApp();

    expect(app).toContain("headPair('Currently deployed'");
    expect(app).toContain("staging.status==='DETACHED_MANUAL_OWNERSHIP'");
    expect(app).toContain(
      "'Currently deployed (detached; physical bytes unknown)'"
    );
    expect(app).toContain("'DEREGISTERED'");
    expect(app).toContain("'DETACHED'");
    expect(app).toContain("headPair('Last successfully validated'");
    expect(app).toContain('staging.last_validated_manifest_id');
    expect(app).toContain('staging.last_validated_frontend_sha');
    expect(app).toContain('staging.last_validated_backend_sha');
    expect(app).toContain(
      "headPair('Last successfully validated (production E2E)'"
    );
    expect(app).toContain('latestProductionManifest()');
    expect(app).toContain('data-lane-control');
    expect(app).toContain(
      "if(state.token)result.Authorization='Bearer '+state.token"
    );
    expect(app).toContain("request('/deploy/release-bus-v2/candidates'");
    expect(app).toContain('/release-bus-v2/production-selections');
    expect(app).toContain('data-select-production');
    expect(app).toContain('revoke-production-readiness');
    expect(app).toContain("request('/deploy/ui/branch-head?");
    expect(app).not.toContain('Mode ');
    expect(app).not.toContain('state.mode');
  });

  it('uses semantic controls, live regions and locale-aware timestamps', () => {
    const html = renderDeployBusUI();
    const app = renderDeployBusUiApp();

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('<details class="registration operator hidden">');
    expect(html).toContain('<label for="pr-filter">PR number</label>');
    expect(html).toContain('<label for="status-filter">Status</label>');
    expect(html).toContain(
      '.pr-title .badge{max-width:100%;white-space:normal;overflow-wrap:anywhere}'
    );
    expect(html).toContain(
      '.heads,.repository-groups,.filters,.registration-form,.metrics{grid-template-columns:minmax(0,1fr)}'
    );
    expect(app).toContain('new Intl.DateTimeFormat');
    expect(app).not.toContain('aria-pressed');
    expect(app).toContain(
      "state.lanes[lane]||{status:'OFF',changeable:false,reason:'Lane state is unavailable'}"
    );
    expect(app).toContain('disabled title="Internal emergency stop is active"');
    expect(app).toContain('function interactionActive()');
    expect(app).toContain("document.querySelector('details[open]')");
    expect(app).toContain('if(!interactionActive())refresh()');
    expect(app).toContain(
      "byId('dashboard').setAttribute('aria-busy','false')"
    );
    expect(app).toContain('new AbortController()');
    expect(app).toContain('controller.abort()},20000');
    expect(app).toContain('delete state.trainDetails[id];throw error');
    expect(app).toContain('await trainDetailSlot(current.id)');
    expect(app).toContain('return result.detail?trainCard');
    expect(app).toContain(
      "if(state.token){connect()}else{showDisconnected('',false);refresh()"
    );
  });
});
