import {
  DEFAULT_DEPLOY_ENVIRONMENT,
  DEFAULT_DEPLOY_REF,
  DEPLOY_REPO_NAME,
  DEPLOY_REPO_OWNER,
  DEPLOY_WORKFLOW_NAME,
  DeployEnvironment,
  DeployServiceConfig
} from '@/api/deploy/deploy.config';
import { LOGO_SVG } from '@/api/health/health-ui.renderer';

type DeployUiBootstrap = {
  default_environment: DeployEnvironment;
  default_ref: string;
  recent_runs_page_size: number;
  repo_owner: string;
  repo_name: string;
  workflow_name: string;
  services: DeployServiceConfig[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEnvironmentBadge(environment: DeployEnvironment): string {
  return `<span class="env-badge env-${environment}">${environment}</span>`;
}

function renderServiceCard(service: DeployServiceConfig): string {
  const environments = service.allowed_environments.join(',');
  const environmentBadges = service.allowed_environments
    .map(renderEnvironmentBadge)
    .join('');

  return `<label class="service-card" data-service-card data-service-name="${escapeHtml(service.name)}" data-environments="${escapeHtml(environments)}">
    <input class="service-checkbox" type="checkbox" value="${escapeHtml(service.name)}" />
    <div class="service-card-header">
      <span class="service-name">${escapeHtml(service.name)}</span>
      <span class="service-toggle" aria-hidden="true"></span>
    </div>
    <div class="service-card-footer">${environmentBadges}</div>
  </label>`;
}

function renderBootstrap(bootstrap: DeployUiBootstrap): string {
  return escapeHtml(JSON.stringify(bootstrap));
}

export function renderDeployUI(services: DeployServiceConfig[]): string {
  const bootstrap: DeployUiBootstrap = {
    default_environment: DEFAULT_DEPLOY_ENVIRONMENT,
    default_ref: DEFAULT_DEPLOY_REF,
    recent_runs_page_size: 8,
    repo_owner: DEPLOY_REPO_OWNER,
    repo_name: DEPLOY_REPO_NAME,
    workflow_name: DEPLOY_WORKFLOW_NAME,
    services
  };

  const serviceCards = services.map(renderServiceCard).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <title>6529 Deploy Console</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="description" content="Dispatch 6529 deploy workflows without fighting the GitHub Actions selector">
  <meta name="theme-color" content="#050505">
  <style>
    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(circle at top, rgba(255, 255, 255, 0.08), transparent 30%),
        linear-gradient(180deg, #050505 0%, #0e0e0e 45%, #151515 100%);
      color: #f2f2f2;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 16px;
    }

    body {
      padding: 16px;
    }

    .shell {
      max-width: 1280px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }

    .protected-sections {
      display: grid;
      gap: 16px;
    }

    .panel {
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(15, 15, 15, 0.88);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(18px);
    }

    .hero {
      padding: 0 4px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
    }

    .logo svg {
      width: 100%;
      height: 100%;
    }

    .brand-title {
      margin: 0;
      display: flex;
      align-items: center;
      font-size: 20px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #d8d8d8;
    }

    .panel {
      border-radius: 20px;
      padding: 18px;
    }

    .panel-title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #9b9b9b;
    }

    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      width: 100%;
      padding: 0;
      margin-bottom: 14px;
      border: 0;
      background: transparent;
      text-align: left;
      color: inherit;
      transform: none;
    }

    .panel-heading:hover {
      transform: none;
    }

    .panel-heading-indicator {
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: #cfcfcf;
      line-height: 1;
    }

    .panel-heading[aria-expanded='true'] .panel-heading-indicator {
      transform: rotate(-90deg);
    }

    .panel-heading-indicator svg {
      width: 16px;
      height: 16px;
      display: block;
    }

    .accordion-content {
      display: grid;
      gap: 18px;
    }

    .auth-shell,
    .control-grid {
      display: grid;
      gap: 16px;
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field-label {
      font-size: 15px;
      color: #bdbdbd;
    }

    .field-help {
      font-size: 14px;
      color: #8f8f8f;
    }

    .input,
    .token-input {
      width: 100%;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(0, 0, 0, 0.34);
      color: #fff;
      padding: 14px 16px;
      font-size: 16px;
      outline: none;
      transition: border-color 120ms ease, background 120ms ease;
    }

    .token-input {
      min-height: 120px;
      resize: vertical;
    }

    .ref-picker {
      position: relative;
    }

    .ref-menu {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      right: 0;
      z-index: 20;
      display: grid;
      gap: 6px;
      padding: 10px;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(7, 7, 7, 0.97);
      box-shadow: 0 22px 60px rgba(0, 0, 0, 0.45);
      max-height: 320px;
      overflow-y: auto;
    }

    .ref-option {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      background: transparent;
      color: #f2f2f2;
      border: 1px solid transparent;
      text-align: left;
      font-size: 14px;
      transform: none;
    }

    .ref-option:hover,
    .ref-option.is-active {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.14);
    }

    .ref-name {
      font-weight: 600;
      word-break: break-word;
    }

    .ref-type {
      flex: 0 0 auto;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 5px 9px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #b9b9b9;
      background: rgba(255, 255, 255, 0.04);
    }

    .ref-empty {
      padding: 12px 14px;
      color: #989898;
      font-size: 13px;
    }

    .input:focus,
    .token-input:focus {
      border-color: rgba(255, 255, 255, 0.34);
      background: rgba(0, 0, 0, 0.48);
    }

    .auth-actions,
    .control-actions,
    .toolbar,
    .section-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .runs-actions {
      justify-content: space-between;
      gap: 12px;
    }

    .runs-pagination {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .runs-page-label {
      min-width: 104px;
      text-align: center;
      color: #9f9f9f;
      font-size: 14px;
      line-height: 1.4;
    }

    .toolbar {
      margin-top: 12px;
      margin-bottom: 2px;
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      font: inherit;
      font-size: 16px;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }

    button:hover {
      transform: translateY(-1px);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    .button-primary {
      background: #f3f3f3;
      color: #070707;
      font-weight: 700;
    }

    .button-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: #f3f3f3;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .env-button {
      background: rgba(255, 255, 255, 0.06);
      color: #d1d1d1;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .env-button.is-active {
      background: #ffffff;
      color: #050505;
      border-color: #ffffff;
    }

    .status-line {
      min-height: 20px;
      font-size: 13px;
      color: #b4b4b4;
    }

    .status-line.is-error {
      color: #ff8e8e;
    }

    .status-line.is-success {
      color: #8df0b3;
    }

    .summary-line {
      color: #d6d6d6;
      font-size: 16px;
      line-height: 1.5;
    }

    .deploy-overview {
      display: grid;
      gap: 10px;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
    }

    .deploy-overview-label {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #8f8f8f;
    }

    .deploy-overview-grid {
      display: grid;
      gap: 8px;
    }

    .deploy-overview-item {
      color: #dfdfdf;
      font-size: 16px;
      line-height: 1.45;
      word-break: break-word;
    }

    .auth-title {
      padding-bottom: 10px;
    }

    .auth-session {
      display: grid;
      gap: 10px;
    }

    .auth-session-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
    }

    .auth-session-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .services-panel {
      display: grid;
      gap: 18px;
    }

    .service-grid {
      display: grid;
      grid-template-columns: repeat(1, minmax(0, 1fr));
      gap: 12px;
    }

    .service-card {
      display: grid;
      gap: 12px;
      border-radius: 18px;
      padding: 16px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.02)),
        rgba(8, 8, 8, 0.92);
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, opacity 120ms ease;
    }

    .service-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.22);
    }

    .service-card.is-disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }

    .service-card.is-hidden {
      display: none;
    }

    .service-card input {
      display: none;
    }

    .service-card.is-selected {
      border-color: #ffffff;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.42);
    }

    .service-card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
    }

    .service-name {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.35;
      word-break: break-word;
    }

    .service-toggle {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      background: rgba(255, 255, 255, 0.04);
      position: relative;
      flex: 0 0 auto;
    }

    .service-card.is-selected .service-toggle {
      background: #fff;
      border-color: #fff;
    }

    .service-card.is-selected .service-toggle::after {
      content: '';
      position: absolute;
      inset: 4px;
      border-radius: 999px;
      background: #070707;
    }

    .service-card-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .env-badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #d0d0d0;
      background: rgba(255, 255, 255, 0.05);
    }

    .env-prod {
      border-color: rgba(255, 132, 132, 0.26);
      color: #ffb2b2;
    }

    .env-staging {
      border-color: rgba(146, 183, 255, 0.26);
      color: #b8d0ff;
    }

    .results-list,
    .runs-list {
      display: grid;
      gap: 10px;
    }

    .result-item,
    .run-item {
      border-radius: 16px;
      padding: 14px 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.03);
    }

    .result-item.is-success {
      border-color: rgba(116, 255, 171, 0.28);
    }

    .result-item.is-error {
      border-color: rgba(255, 142, 142, 0.28);
    }

    .run-line {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }

    .run-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .run-title {
      font-size: 16px;
      font-weight: 600;
      color: #f5f5f5;
      text-decoration: none;
    }

    .run-title:hover {
      text-decoration: underline;
    }

    .run-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: #d8d8d8;
      text-decoration: none;
    }

    .run-link:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .run-link svg {
      width: 15px;
      height: 15px;
      display: block;
    }

    .run-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
      color: #9f9f9f;
      font-size: 14px;
    }

    .run-status {
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.08);
      color: #dedede;
    }

    .run-status.is-completed {
      background: rgba(126, 255, 176, 0.14);
      color: #95f7bc;
    }

    .run-status.is-failed {
      background: rgba(255, 117, 117, 0.16);
      color: #ffaaaa;
    }

    .run-status.is-progress {
      background: rgba(126, 177, 255, 0.16);
      color: #b7d0ff;
    }

    .hidden {
      display: none !important;
    }

    .token-input:disabled,
    .input:disabled {
      opacity: 0.58;
      cursor: not-allowed;
    }

    .token-input.is-locked {
      pointer-events: none;
      user-select: none;
    }

    @media (min-width: 700px) {
      body {
        padding: 20px;
      }

      .shell {
        gap: 20px;
      }

      .protected-sections {
        gap: 20px;
      }

      .service-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (min-width: 1040px) {
      body {
        padding: 24px;
      }

      .shell {
        gap: 24px;
      }

      .protected-sections {
        gap: 24px;
      }

      .panel {
        padding: 20px;
      }

      .control-grid {
        grid-template-columns: 1.1fr 0.9fr;
        align-items: start;
      }
    }

    @media (min-width: 1280px) {
      .service-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }

    @media (max-width: 699px) {
      .brand-title {
        font-size: 18px;
        letter-spacing: 0.14em;
      }

      .panel-title {
        font-size: 17px;
      }

      .panel-heading {
        margin-bottom: 10px;
      }

      .auth-session-head {
        align-items: stretch;
        flex-direction: column;
      }

      .toolbar {
        gap: 8px;
      }

      .toolbar .input {
        flex: 1 1 100%;
      }

      .runs-actions {
        align-items: stretch;
      }

      .runs-pagination {
        width: 100%;
        justify-content: space-between;
      }

      .runs-page-label {
        flex: 1 1 auto;
      }

      .control-actions {
        gap: 8px;
      }

      .control-actions button,
      .auth-actions button {
        width: 100%;
        justify-content: center;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="brand">
        <div class="logo">${LOGO_SVG}</div>
        <h1 class="brand-title">6529 Deploy Console</h1>
      </div>
    </section>

    <section class="panel">
      <h2 class="panel-title auth-title">Authenticate</h2>
      <div class="auth-shell">
        <div id="auth-entry" class="field hidden">
          <label class="field-label" for="token-input">GitHub token</label>
          <textarea id="token-input" class="token-input" spellcheck="false" placeholder="Paste a GitHub PAT with repo/workflow access here"></textarea>
          <div class="auth-actions">
            <button id="connect-button" type="button" class="button-primary">Unlock deploy UI</button>
          </div>
        </div>
        <div class="auth-session">
          <div class="auth-session-head">
            <div class="field-label">Session</div>
          </div>
          <div class="auth-session-row">
            <div id="session-summary" class="summary-line">Checking session...</div>
            <button id="forget-button" type="button" class="button-secondary">Forget</button>
          </div>
          <div id="auth-status" class="status-line"></div>
        </div>
      </div>
    </section>

    <div id="protected-sections" class="protected-sections hidden">
    <section class="panel">
      <button
        id="recent-runs-toggle"
        class="panel-heading"
        type="button"
        aria-expanded="false"
        aria-controls="recent-runs-content">
        <h2 class="panel-title">Recent Runs</h2>
        <span class="panel-heading-indicator" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </button>
      <div id="recent-runs-content" class="accordion-content">
        <div class="section-actions runs-actions">
          <button id="refresh-runs-button" type="button" class="button-secondary" disabled>Refresh runs</button>
          <div class="runs-pagination">
            <button id="runs-prev-button" type="button" class="button-secondary" disabled>Previous</button>
            <div id="runs-page-label" class="runs-page-label">Page 1</div>
            <button id="runs-next-button" type="button" class="button-secondary" disabled>Next</button>
          </div>
        </div>
        <div id="runs-panel" class="runs-list">
          <div class="run-item">Authenticate to load recent deploy runs.</div>
        </div>
      </div>
    </section>

    <section class="panel services-panel">
      <button
        id="deploy-batch-toggle"
        class="panel-heading"
        type="button"
        aria-expanded="true"
        aria-controls="deploy-batch-content">
        <h2 class="panel-title">Deploy Batch</h2>
        <span class="panel-heading-indicator" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </button>
      <div id="deploy-batch-content" class="accordion-content">
        <div class="control-grid">
          <div class="field">
            <label class="field-label" for="ref-input">Git ref</label>
            <div class="ref-picker">
              <input id="ref-input" class="input" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(DEFAULT_DEPLOY_REF)}" />
              <div id="ref-menu" class="ref-menu hidden"></div>
            </div>
            <div class="field-help">Branch or tag to hand to the workflow dispatch API.</div>
          </div>
          <div class="field">
            <div class="field-label">Environment</div>
            <div class="control-actions">
              <button type="button" class="env-button is-active" data-env-button data-environment="staging">STAGING</button>
              <button type="button" class="env-button" data-env-button data-environment="prod">PRODUCTION</button>
            </div>
          </div>
        </div>

        <div class="toolbar">
          <input id="service-search" class="input" type="search" placeholder="Filter services" />
          <button id="select-visible-button" type="button" class="button-secondary">Select visible</button>
          <button id="clear-selection-button" type="button" class="button-secondary">Clear selected</button>
        </div>

        <div id="selected-summary" class="summary-line">0 services selected.</div>
        <div id="service-grid" class="service-grid">${serviceCards}</div>

        <div id="deploy-overview" class="deploy-overview">
          <div class="deploy-overview-label">Deploy Overview</div>
          <div class="deploy-overview-grid">
            <div id="deploy-overview-ref" class="deploy-overview-item">Ref: ${escapeHtml(DEFAULT_DEPLOY_REF)}</div>
            <div id="deploy-overview-environment" class="deploy-overview-item">Environment: ${escapeHtml(DEFAULT_DEPLOY_ENVIRONMENT)}</div>
            <div id="deploy-overview-services" class="deploy-overview-item">Services: none selected</div>
          </div>
        </div>

        <div class="control-actions">
          <button id="deploy-button" type="button" class="button-primary" disabled>Dispatch deploy batch</button>
        </div>
        <div id="deploy-status" class="status-line"></div>
        <div id="results-panel" class="results-list hidden"></div>
      </div>
    </section>
    </div>
  </main>

  <template id="deploy-ui-bootstrap">${renderBootstrap(bootstrap)}</template>
  <script src="/deploy/ui/app.js" defer></script>
</body>
</html>`;
}

export function renderDeployUiApp(): string {
  return `'use strict';

(function () {
  var TOKEN_STORAGE_KEY = 'deploy-ui-token';
  var bootstrapNode = document.getElementById('deploy-ui-bootstrap');
  var bootstrap = JSON.parse((bootstrapNode && bootstrapNode.textContent) || '{}');

  var authEntry = document.getElementById('auth-entry');
  var tokenInput = document.getElementById('token-input');
  var connectButton = document.getElementById('connect-button');
  var forgetButton = document.getElementById('forget-button');
  var authStatus = document.getElementById('auth-status');
  var sessionSummary = document.getElementById('session-summary');
  var protectedSections = document.getElementById('protected-sections');
  var refInput = document.getElementById('ref-input');
  var refMenu = document.getElementById('ref-menu');
  var deployButton = document.getElementById('deploy-button');
  var refreshRunsButton = document.getElementById('refresh-runs-button');
  var runsPrevButton = document.getElementById('runs-prev-button');
  var runsNextButton = document.getElementById('runs-next-button');
  var runsPageLabel = document.getElementById('runs-page-label');
  var deployStatus = document.getElementById('deploy-status');
  var deployOverviewRef = document.getElementById('deploy-overview-ref');
  var deployOverviewEnvironment = document.getElementById('deploy-overview-environment');
  var deployOverviewServices = document.getElementById('deploy-overview-services');
  var runsPanel = document.getElementById('runs-panel');
  var resultsPanel = document.getElementById('results-panel');
  var accordionToggles = Array.prototype.slice.call(document.querySelectorAll('[aria-controls]'));
  var serviceSearch = document.getElementById('service-search');
  var selectedSummary = document.getElementById('selected-summary');
  var selectVisibleButton = document.getElementById('select-visible-button');
  var clearSelectionButton = document.getElementById('clear-selection-button');
  var envButtons = Array.prototype.slice.call(document.querySelectorAll('[data-env-button]'));
  var serviceCards = Array.prototype.slice.call(document.querySelectorAll('[data-service-card]'));
  var state = {
    token: null,
    isCheckingSession: true,
    environment: bootstrap.default_environment || 'staging',
    runsTimer: null,
    runsPage: 1,
    runsPageSize: bootstrap.recent_runs_page_size || 8,
    runsCurrentCount: 0,
    runsTotalCount: null,
    runsHasPreviousPage: false,
    runsHasNextPage: false,
    refOptions: [],
    refMenuOpen: false,
    refActiveIndex: -1,
    refRequestId: 0,
    refSearchTimer: null
  };

  function setStatus(node, message, kind) {
    node.textContent = message || '';
    node.classList.remove('is-error');
    node.classList.remove('is-success');
    if (kind === 'error') {
      node.classList.add('is-error');
    } else if (kind === 'success') {
      node.classList.add('is-success');
    }
  }

  function setAccordionExpanded(toggle, expanded) {
    var contentId = toggle.getAttribute('aria-controls');
    var content = contentId ? document.getElementById(contentId) : null;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (content) {
      content.classList.toggle('hidden', !expanded);
    }
  }

  function getAuthHeaders() {
    return {
      'X-GitHub-Token': state.token
    };
  }

  function syncProtectedSections() {
    var showProtectedSections = !!state.token && !state.isCheckingSession;
    protectedSections.classList.toggle('hidden', !showProtectedSections);
  }

  function syncAuthControls() {
    var showEntry = !state.token && !state.isCheckingSession;
    authEntry.classList.toggle('hidden', !showEntry);
    tokenInput.disabled = !showEntry;
    tokenInput.readOnly = !showEntry;
    tokenInput.tabIndex = showEntry ? 0 : -1;
    tokenInput.classList.toggle('is-locked', !showEntry);
    tokenInput.setAttribute('aria-disabled', showEntry ? 'false' : 'true');
    connectButton.classList.toggle('hidden', !showEntry);
    connectButton.hidden = !showEntry;
    connectButton.style.display = !showEntry ? 'none' : '';
    var showForgetButton = !!state.token && !state.isCheckingSession;
    forgetButton.classList.toggle('hidden', !showForgetButton);
    forgetButton.hidden = !showForgetButton;
    forgetButton.style.display = !showForgetButton ? 'none' : '';
    syncProtectedSections();
  }

  function updateRunsPagination() {
    if (!state.token || state.isCheckingSession) {
      runsPageLabel.textContent = 'Waiting for session';
    } else if (state.runsTotalCount === 0) {
      runsPageLabel.textContent = '0 runs';
    } else if (state.runsCurrentCount > 0 && state.runsTotalCount !== null) {
      var start = (state.runsPage - 1) * state.runsPageSize + 1;
      var end = start + state.runsCurrentCount - 1;
      runsPageLabel.textContent = start + '-' + end + ' of ' + state.runsTotalCount;
    } else {
      runsPageLabel.textContent = 'Page ' + state.runsPage;
    }

    refreshRunsButton.disabled = !state.token;
    runsPrevButton.disabled = !state.token || !state.runsHasPreviousPage;
    runsNextButton.disabled = !state.token || !state.runsHasNextPage;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    var text = await response.text();
    var payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      var message = payload.error || payload.message || response.status + ' ' + response.statusText;
      throw new Error(message);
    }
    return payload;
  }

  function selectedServices() {
    return serviceCards
      .filter(function (card) {
        if (card.classList.contains('is-disabled')) {
          return false;
        }
        var checkbox = card.querySelector('input');
        return !!(checkbox && checkbox.checked);
      })
      .map(function (card) {
        return card.getAttribute('data-service-name');
      });
  }

  function updateSelectedSummary() {
    var selected = selectedServices();
    selectedSummary.textContent = selected.length + ' service' + (selected.length === 1 ? '' : 's') + ' selected.';
    deployButton.disabled = !state.token || selected.length === 0;
    updateDeployOverview();
  }

  function updateDeployOverview() {
    var selected = selectedServices();
    var servicesText = 'none selected';
    if (selected.length > 0) {
      servicesText = selected.join(', ');
    }

    deployOverviewRef.textContent = 'Ref: ' + ((refInput.value || '').trim() || 'none');
    deployOverviewEnvironment.textContent =
      'Environment: ' + state.environment;
    deployOverviewServices.textContent = 'Services: ' + servicesText;
  }

  function setRefMenuOpen(isOpen) {
    state.refMenuOpen = isOpen;
    refMenu.classList.toggle('hidden', !isOpen);
  }

  function renderRefOptions() {
    if (!state.refMenuOpen) {
      return;
    }

    if (!state.refOptions.length) {
      refMenu.innerHTML =
        '<div class="ref-empty">No matching branches or tags.</div>';
      return;
    }

    refMenu.innerHTML = state.refOptions
      .map(function (option, index) {
        var activeClass = index === state.refActiveIndex ? ' is-active' : '';
        return (
          '<button type="button" class="ref-option' +
          activeClass +
          '" data-ref-option="' +
          index +
          '">' +
          '<span class="ref-name">' +
          escapeHtml(option.name) +
          '</span>' +
          '<span class="ref-type">' +
          escapeHtml(option.type) +
          '</span>' +
          '</button>'
        );
      })
      .join('');
  }

  function applyRefSelection(option) {
    refInput.value = option.name;
    state.refActiveIndex = -1;
    setRefMenuOpen(false);
    updateDeployOverview();
  }

  async function loadRefOptions(query) {
    if (!state.token) {
      return;
    }

    var requestId = ++state.refRequestId;
    try {
      var payload = await fetchJson(
        '/deploy/ui/refs?q=' + encodeURIComponent(query || ''),
        {
          headers: getAuthHeaders()
        }
      );

      if (requestId !== state.refRequestId) {
        return;
      }

      state.refOptions = payload.refs || [];
      state.refActiveIndex = state.refOptions.length ? 0 : -1;
      setRefMenuOpen(true);
      renderRefOptions();
    } catch (error) {
      if (requestId !== state.refRequestId) {
        return;
      }
      state.refOptions = [];
      state.refActiveIndex = -1;
      setRefMenuOpen(true);
      refMenu.innerHTML =
        '<div class="ref-empty">' + escapeHtml(error.message) + '</div>';
    }
  }

  function queueRefSearch() {
    if (!state.token) {
      return;
    }

    if (state.refSearchTimer) {
      clearTimeout(state.refSearchTimer);
    }

    state.refSearchTimer = window.setTimeout(function () {
      loadRefOptions((refInput.value || '').trim());
    }, 150);
  }

  function applyEnvironmentFilter() {
    envButtons.forEach(function (button) {
      button.classList.toggle(
        'is-active',
        button.getAttribute('data-environment') === state.environment
      );
    });

    serviceCards.forEach(function (card) {
      var allowedEnvironments = (card.getAttribute('data-environments') || '').split(',');
      var searchTerm = (serviceSearch.value || '').trim().toLowerCase();
      var name = (card.getAttribute('data-service-name') || '').toLowerCase();
      var supported = allowedEnvironments.indexOf(state.environment) >= 0;
      var visible = !searchTerm || name.indexOf(searchTerm) >= 0;
      card.classList.toggle('is-disabled', !supported);
      card.classList.toggle('is-hidden', !visible);
      var checkbox = card.querySelector('input');
      if (checkbox && !supported) {
        checkbox.checked = false;
        card.classList.remove('is-selected');
      }
    });

    updateSelectedSummary();
  }

  function renderRuns(runs) {
    if (!runs || runs.length === 0) {
      runsPanel.innerHTML = '<div class="run-item">No recent deploy runs found.</div>';
      return;
    }

    runsPanel.innerHTML = runs
      .map(function (run) {
        var outcome = run.conclusion || run.status || 'unknown';
        var outcomeClass = 'is-progress';
        if (outcome === 'success' || outcome === 'completed') {
          outcomeClass = 'is-completed';
        } else if (outcome === 'failure' || outcome === 'cancelled' || outcome === 'timed_out' || outcome === 'action_required') {
          outcomeClass = 'is-failed';
        }

        var parts = [];
        if (run.ref) {
          parts.push('ref ' + run.ref);
        }
        if (run.actor) {
          parts.push('by ' + run.actor);
        }
        if (run.updated_at) {
          parts.push('updated ' + new Date(run.updated_at).toLocaleString());
        }

        return '<div class="run-item">' +
          '<div class="run-line">' +
            '<a class="run-title" target="_blank" rel="noreferrer" href="' + run.url + '">' + run.title + '</a>' +
            '<span class="run-actions">' +
              '<span class="run-status ' + outcomeClass + '">' + outcome + '</span>' +
              '<a class="run-link" target="_blank" rel="noreferrer" href="' + run.url + '" aria-label="Open run on GitHub" title="Open run on GitHub">' +
                '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                  '<path d="M6 4H4.5C4.10218 4 3.72064 4.15804 3.43934 4.43934C3.15804 4.72064 3 5.10218 3 5.5V11.5C3 11.8978 3.15804 12.2794 3.43934 12.5607C3.72064 12.842 4.10218 13 4.5 13H10.5C10.8978 13 11.2794 12.842 11.5607 12.5607C11.842 12.2794 12 11.8978 12 11.5V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                  '<path d="M8.5 3H13V7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                  '<path d="M13 3L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
              '</a>' +
            '</span>' +
          '</div>' +
          '<div class="run-meta">' + parts.map(function (part) { return '<span>' + part + '</span>'; }).join('') + '</div>' +
        '</div>';
      })
      .join('');
  }

  function applyRunsPage(runsPage) {
    var page = runsPage || {};
    var runs = page.runs || [];

    state.runsPage = page.page || 1;
    state.runsPageSize = page.page_size || state.runsPageSize;
    state.runsCurrentCount = runs.length;
    state.runsTotalCount =
      typeof page.total_count === 'number' ? page.total_count : null;
    state.runsHasPreviousPage = !!page.has_previous_page;
    state.runsHasNextPage = !!page.has_next_page;

    renderRuns(runs);
    updateRunsPagination();
  }

  function renderResults(items) {
    if (!items || items.length === 0) {
      resultsPanel.classList.add('hidden');
      resultsPanel.innerHTML = '';
      return;
    }

    resultsPanel.classList.remove('hidden');
    resultsPanel.innerHTML = items.map(function (item) {
      var className = item.ok ? 'is-success' : 'is-error';
      return '<div class="result-item ' + className + '">' +
        '<strong>' + item.service + '</strong>: ' + item.message +
      '</div>';
    }).join('');
  }

  async function loadRuns(page) {
    if (!state.token) {
      return;
    }

    var targetPage = Number(page) > 0 ? Number(page) : state.runsPage;
    refreshRunsButton.disabled = true;
    runsPrevButton.disabled = true;
    runsNextButton.disabled = true;
    try {
      var payload = await fetchJson(
        '/deploy/ui/runs?page=' +
          encodeURIComponent(String(targetPage)) +
          '&page_size=' +
          encodeURIComponent(String(state.runsPageSize)),
        {
          headers: getAuthHeaders()
        }
      );
      applyRunsPage(payload.runs_page || {});
    } catch (error) {
      state.runsPage = targetPage;
      state.runsCurrentCount = 0;
      state.runsTotalCount = null;
      state.runsHasPreviousPage = targetPage > 1;
      state.runsHasNextPage = false;
      renderRuns([]);
      updateRunsPagination();
      setStatus(deployStatus, error.message, 'error');
    } finally {
      updateRunsPagination();
    }
  }

  async function authenticate(token) {
    state.isCheckingSession = true;
    syncAuthControls();
    setStatus(authStatus, 'Checking deploy permissions...', null);
    var payload = await fetchJson('/deploy/ui/session', {
      headers: {
        'X-GitHub-Token': token
      }
    });

    state.token = token;
    state.isCheckingSession = false;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    syncAuthControls();
    tokenInput.value = '';
    sessionSummary.textContent =
      'Authenticated as GitHub user ' + payload.login + '.';
    deployButton.disabled = selectedServices().length === 0;
    setStatus(authStatus, '', null);
    applyRunsPage(payload.runs_page || {});

    if (state.runsTimer) {
      clearInterval(state.runsTimer);
    }
    state.runsTimer = window.setInterval(loadRuns, 15000);
  }

  async function onConnect() {
    var token = (tokenInput.value || '').trim();
    if (!token) {
      setStatus(authStatus, 'Paste a GitHub token first.', 'error');
      return;
    }

    try {
      await authenticate(token);
    } catch (error) {
      state.token = null;
      state.isCheckingSession = false;
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      syncAuthControls();
      sessionSummary.textContent = 'No active session.';
      tokenInput.value = token;
      deployButton.disabled = true;
      state.runsPage = 1;
      state.runsCurrentCount = 0;
      state.runsTotalCount = null;
      state.runsHasPreviousPage = false;
      state.runsHasNextPage = false;
      updateRunsPagination();
      setStatus(authStatus, error.message, 'error');
    }
  }

  function onForget() {
    state.token = null;
    state.isCheckingSession = false;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    tokenInput.value = '';
    syncAuthControls();
    sessionSummary.textContent = 'No active session.';
    deployButton.disabled = true;
    state.runsPage = 1;
    state.runsCurrentCount = 0;
    state.runsTotalCount = null;
    state.runsHasPreviousPage = false;
    state.runsHasNextPage = false;
    renderResults([]);
    renderRuns([]);
    updateRunsPagination();
    setStatus(authStatus, 'Stored token cleared.', 'success');
    setStatus(deployStatus, '', null);
    state.refOptions = [];
    state.refActiveIndex = -1;
    setRefMenuOpen(false);
    if (state.runsTimer) {
      clearInterval(state.runsTimer);
      state.runsTimer = null;
    }
  }

  async function onDeploy() {
    var services = selectedServices();
    var ref = (refInput.value || '').trim();
    if (!state.token) {
      setStatus(deployStatus, 'Authenticate first.', 'error');
      return;
    }
    if (!ref) {
      setStatus(deployStatus, 'Ref is required.', 'error');
      return;
    }
    if (services.length === 0) {
      setStatus(deployStatus, 'Select at least one service.', 'error');
      return;
    }

    deployButton.disabled = true;
    setStatus(
      deployStatus,
      'Dispatching ' + services.length + ' service' + (services.length === 1 ? '' : 's') + ' to ' + state.environment + '...',
      null
    );

    try {
      var payload = await fetchJson('/deploy/ui/dispatch', {
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json'
          },
          getAuthHeaders()
        ),
        body: JSON.stringify({
          ref: ref,
          environment: state.environment,
          services: services
        })
      });
      renderResults(payload.results || []);
      setStatus(
        deployStatus,
        'Dispatch complete. GitHub may take a few seconds to surface the new runs.',
        'success'
      );
      window.setTimeout(function () {
        loadRuns(1);
      }, 2500);
      window.setTimeout(function () {
        loadRuns(1);
      }, 7000);
    } catch (error) {
      setStatus(deployStatus, error.message, 'error');
    } finally {
      deployButton.disabled = selectedServices().length === 0 || !state.token;
    }
  }

  connectButton.addEventListener('click', onConnect);
  forgetButton.addEventListener('click', onForget);
  deployButton.addEventListener('click', onDeploy);
  refreshRunsButton.addEventListener('click', loadRuns);
  runsPrevButton.addEventListener('click', function () {
    if (!state.runsHasPreviousPage) {
      return;
    }
    loadRuns(state.runsPage - 1);
  });
  runsNextButton.addEventListener('click', function () {
    if (!state.runsHasNextPage) {
      return;
    }
    loadRuns(state.runsPage + 1);
  });
  accordionToggles.forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true';
      setAccordionExpanded(toggle, !expanded);
    });
  });
  selectVisibleButton.addEventListener('click', function () {
    serviceCards.forEach(function (card) {
      if (card.classList.contains('is-disabled') || card.classList.contains('is-hidden')) {
        return;
      }
      var checkbox = card.querySelector('input');
      if (!checkbox) {
        return;
      }
      checkbox.checked = true;
      card.classList.add('is-selected');
    });
    updateSelectedSummary();
  });
  clearSelectionButton.addEventListener('click', function () {
    serviceCards.forEach(function (card) {
      var checkbox = card.querySelector('input');
      if (!checkbox) {
        return;
      }
      checkbox.checked = false;
      card.classList.remove('is-selected');
    });
    updateSelectedSummary();
  });

  envButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      state.environment = button.getAttribute('data-environment');
      applyEnvironmentFilter();
      updateDeployOverview();
    });
  });

  refInput.addEventListener('focus', function () {
    if (!state.token) {
      return;
    }
    queueRefSearch();
  });

  refInput.addEventListener('input', function () {
    queueRefSearch();
    updateDeployOverview();
  });

  refInput.addEventListener('keydown', function (event) {
    if (!state.refMenuOpen || !state.refOptions.length) {
      if (event.key === 'ArrowDown' && state.token) {
        queueRefSearch();
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.refActiveIndex =
        (state.refActiveIndex + 1) % state.refOptions.length;
      renderRefOptions();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.refActiveIndex =
        (state.refActiveIndex - 1 + state.refOptions.length) %
        state.refOptions.length;
      renderRefOptions();
      return;
    }

    if (event.key === 'Enter' && state.refActiveIndex >= 0) {
      event.preventDefault();
      applyRefSelection(state.refOptions[state.refActiveIndex]);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setRefMenuOpen(false);
    }
  });

  refMenu.addEventListener('mousedown', function (event) {
    var optionNode = event.target.closest('[data-ref-option]');
    if (!optionNode) {
      return;
    }
    event.preventDefault();
    var index = Number(optionNode.getAttribute('data-ref-option'));
    if (!Number.isNaN(index) && state.refOptions[index]) {
      applyRefSelection(state.refOptions[index]);
    }
  });

  document.addEventListener('mousedown', function (event) {
    var target = event.target;
    if (
      target === refInput ||
      target === refMenu ||
      refMenu.contains(target)
    ) {
      return;
    }
    setRefMenuOpen(false);
  });

  serviceCards.forEach(function (card) {
    card.addEventListener('click', function (event) {
      if (card.classList.contains('is-disabled')) {
        event.preventDefault();
        return;
      }
      var checkbox = card.querySelector('input');
      if (!checkbox) {
        return;
      }
      window.setTimeout(function () {
        card.classList.toggle('is-selected', !!checkbox.checked);
        updateSelectedSummary();
      }, 0);
    });
  });

  serviceSearch.addEventListener('input', applyEnvironmentFilter);

  var storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
  tokenInput.value = '';
  syncAuthControls();
  applyEnvironmentFilter();
  updateDeployOverview();
  updateRunsPagination();
  setAccordionExpanded(document.getElementById('recent-runs-toggle'), false);
  setAccordionExpanded(document.getElementById('deploy-batch-toggle'), true);

  if (storedToken.trim()) {
    state.token = storedToken.trim();
    state.isCheckingSession = true;
    syncAuthControls();
    authenticate(storedToken.trim()).catch(function () {
      state.token = null;
      state.isCheckingSession = false;
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      state.runsPage = 1;
      state.runsCurrentCount = 0;
      state.runsTotalCount = null;
      state.runsHasPreviousPage = false;
      state.runsHasNextPage = false;
      syncAuthControls();
      sessionSummary.textContent = 'No active session.';
      updateRunsPagination();
    });
  } else {
    state.isCheckingSession = false;
    sessionSummary.textContent = 'No active session.';
    syncAuthControls();
    updateRunsPagination();
  }
})();
`;
}
