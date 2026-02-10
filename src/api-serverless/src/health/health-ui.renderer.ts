import { HealthData } from './health.service';

export const LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg id="Layer_1" xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 1920 1920">
  <defs>
    <style>
      .st0 {
        fill: none;
      }

      .st1 {
        fill: #fff;
      }
    </style>
  </defs>
  <rect class="st0" x="450.9" y="1265.5" width="1018.2" height="67.9"/>
  <rect class="st0" x="450.9" y="586.7" width="1018.2" height="67.9"/>
  <g>
    <polygon class="st1" points="0 1016.5 790.6 1016.5 790.6 1129.4 0 1129.4 0 1242.3 903.5 1242.3 903.5 903.5 112.9 903.5 112.9 790.6 1807.1 790.6 1807.1 903.5 1016.5 903.5 1016.5 1242.3 1920 1242.3 1920 1129.4 1129.4 1129.4 1129.4 1016.5 1920 1016.5 1920 677.7 0 677.7 0 1016.5"/>
    <path class="st1" d="M0,1694.2h1807.1v112.9H0v112.9h1920v-564.7H0v338.8ZM112.9,1468.2h1694.2v112.9H112.9v-112.9h0Z"/>
    <path class="st1" d="M1920,112.9V0H0v564.7h1920V225.8H112.9v-112.9h1807.1,0ZM1807.1,338.8v112.9H112.9v-112.9h1694.2Z"/>
  </g>
</svg>`;

function getStatusClassOk(): string {
  return 'status-ok';
}

function getStatusClassDegraded(): string {
  return 'status-degraded';
}

function getStatusDisplayOk(): string {
  return 'OK';
}

function getStatusDisplayDegraded(): string {
  return 'Degraded';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getRedisStatusClass(redis: HealthData['redis']): string {
  if (!redis.enabled) {
    return 'status-degraded';
  }
  return redis.healthy ? 'status-ok' : 'status-degraded';
}

function getArweaveStatusClass(arweave: HealthData['arweave']): string {
  return arweave.healthy ? 'status-ok' : 'status-degraded';
}

function buildArweaveHtml(arweave: HealthData['arweave']): string {
  const formatIntegerLike = (value: string): string => {
    try {
      return BigInt(value).toLocaleString();
    } catch {
      return value;
    }
  };
  const formatArRounded = (value: string): string => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
      return value;
    }
    return parsed.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  };

  const statusClass = getArweaveStatusClass(arweave);
  const statusText = arweave.healthy ? 'Healthy' : 'Degraded';
  let html = `<span class="status-badge ${statusClass}">${escapeHtml(statusText)}</span>`;

  html += '<div class="nested-object">';

  if (arweave.wallet_address) {
    html += `<div class="nested-key">Wallet: <span class="nested-value">${escapeHtml(arweave.wallet_address)}</span></div>`;
  }
  if (arweave.balance) {
    html += `<div class="nested-key">Balance: <span class="nested-value">${escapeHtml(formatArRounded(arweave.balance.ar))} AR (${escapeHtml(arweave.balance.level)})</span></div>`;
    if (arweave.balance.estimated_50mb_uploads) {
      html += `<div class="nested-key">Est. 50MB uploads: <span class="nested-value">~${escapeHtml(formatIntegerLike(arweave.balance.estimated_50mb_uploads))}</span></div>`;
    }
    if (arweave.balance.estimated_3500mb_uploads) {
      html += `<div class="nested-key">Est. 3.5GB uploads: <span class="nested-value">~${escapeHtml(formatIntegerLike(arweave.balance.estimated_3500mb_uploads))}</span></div>`;
    }
  }

  html += '</div>';
  return html;
}

function buildRedisHtml(
  redis: HealthData['redis'],
  statusClass: string
): string {
  if (redis.enabled) {
    return `
              <span class="status-badge ${statusClass}">Enabled</span>
              <div class="nested-object">
                <div class="nested-key">Healthy: <span class="nested-value">${redis.healthy ? 'Yes' : 'No'}</span></div>
              </div>`;
  }
  return `<span class="status-badge ${statusClass}">Disabled</span>`;
}

function buildRateLimitAuthenticatedHtml(
  authenticated: HealthData['rate_limit']['authenticated']
): string {
  if (!authenticated) {
    return '';
  }
  return `
                <div class="nested-key">Authenticated:</div>
                <div class="nested-object">
                  <div class="nested-key">Burst: <span class="nested-value">${authenticated.burst}</span></div>
                  <div class="nested-key">Sustained RPS: <span class="nested-value">${authenticated.sustained_rps}</span></div>
                  <div class="nested-key">Window: <span class="nested-value">${authenticated.sustained_window_seconds}s</span></div>
                </div>`;
}

function buildRateLimitUnauthenticatedHtml(
  unauthenticated: HealthData['rate_limit']['unauthenticated']
): string {
  if (!unauthenticated) {
    return '';
  }
  return `
                <div class="nested-key">Unauthenticated:</div>
                <div class="nested-object">
                  <div class="nested-key">Burst: <span class="nested-value">${unauthenticated.burst}</span></div>
                  <div class="nested-key">Sustained RPS: <span class="nested-value">${unauthenticated.sustained_rps}</span></div>
                  <div class="nested-key">Window: <span class="nested-value">${unauthenticated.sustained_window_seconds}s</span></div>
                </div>`;
}

function buildRateLimitHtml(rateLimit: HealthData['rate_limit']): string {
  const statusClass = rateLimit.enabled
    ? getStatusClassOk()
    : getStatusClassDegraded();
  const enabledText = rateLimit.enabled ? 'Enabled' : 'Disabled';
  let html = `<span class="status-badge ${statusClass}">${enabledText}</span>`;

  if (!rateLimit.enabled) {
    return html;
  }

  html += '<div class="nested-object">';
  html += buildRateLimitAuthenticatedHtml(rateLimit.authenticated);
  html += buildRateLimitUnauthenticatedHtml(rateLimit.unauthenticated);

  if (rateLimit.internal_enabled) {
    html += `<div class="nested-key">Internal: <span class="nested-value">Enabled</span></div>`;
  }

  html += '</div>';
  return html;
}

export function renderHealthUI(data: HealthData, baseUrl?: string): string {
  const statusDisplay =
    data.status === 'ok' ? getStatusDisplayOk() : getStatusDisplayDegraded();
  const statusClass =
    data.status === 'ok' ? getStatusClassOk() : getStatusClassDegraded();
  const dbDisplay =
    data.db === 'ok' ? getStatusDisplayOk() : getStatusDisplayDegraded();
  const dbClass =
    data.db === 'ok' ? getStatusClassOk() : getStatusClassDegraded();

  const redisStatusClass = getRedisStatusClass(data.redis);
  const arweaveHtml = buildArweaveHtml(data.arweave);
  const redisHtml = buildRedisHtml(data.redis, redisStatusClass);
  const rateLimitHtml = buildRateLimitHtml(data.rate_limit);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <title>6529 API Health</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="description" content="Real-time health status of the 6529 API">
  <meta name="theme-color" content="#0a0a0a">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="6529 API Health">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon.svg">
  <link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg">
  <meta property="og:title" content="6529 API Health Status">
  <meta property="og:description" content="Real-time health status of the 6529 API">
  <meta property="og:type" content="website">
  ${baseUrl ? `<meta property="og:url" content="${baseUrl}/health/ui">` : ''}
  <meta property="og:image" content="https://6529.io/6529io.png">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .container {
      max-width: 900px;
      width: 100%;
      background: #1e1e1e;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      border: 1px solid #333;
    }

    .header {
      text-align: center;
      margin-bottom: 1.5rem;
    }

    .logo {
      width: 60px;
      height: 60px;
      margin: 0 auto 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .logo svg {
      width: 100%;
      height: 100%;
    }

    h1 {
      color: #ffffff;
      font-size: 1.75rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .status-badge {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 20px;
      font-weight: 600;
      font-size: 0.9rem;
      margin-top: 0.5rem;
      word-break: break-word;
    }

    .status-ok {
      background: #10b981;
      color: #ffffff;
    }

    .status-degraded {
      background: #f59e0b;
      color: #ffffff;
    }

    .table-wrapper {
      width: 100%;
      overflow-x: auto;
      margin-top: 1.5rem;
      -webkit-overflow-scrolling: touch;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 300px;
    }

    thead {
      background: #2a2a2a;
    }

    th {
      padding: 0.75rem;
      text-align: left;
      font-weight: 600;
      color: #ffffff;
      border-bottom: 2px solid #3a3a3a;
      font-size: 0.9rem;
    }

    td {
      padding: 0.75rem;
      border-bottom: 1px solid #2a2a2a;
      color: #d0d0d0;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    td:first-child {
      width: 30%;
      max-width: 150px;
    }

    td:last-child {
      width: 70%;
    }

    tr:hover {
      background: #252525;
    }

    .value-cell {
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 0.85rem;
      word-break: break-word;
    }

    .nested-object {
      margin-left: 0.5rem;
      padding-left: 0.75rem;
      border-left: 2px solid #3a3a3a;
      margin-top: 0.5rem;
    }

    .nested-key {
      color: #a0a0a0;
      font-size: 0.8rem;
      margin-top: 0.25rem;
      word-break: break-word;
    }

    .nested-value {
      color: #e0e0e0;
      margin-left: 0.5rem;
      word-break: break-word;
    }

    a {
      color: #10b981;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .footer {
      margin-top: 1.5rem;
      text-align: center;
      color: #888;
      font-size: 0.8rem;
    }

    @media (max-width: 768px) {
      body {
        padding: 0.5rem;
      }

      .container {
        padding: 1rem;
        border-radius: 8px;
      }

      h1 {
        font-size: 1.5rem;
      }

      .logo {
        width: 50px;
        height: 50px;
      }

      th, td {
        padding: 0.5rem;
        font-size: 0.85rem;
      }

      .value-cell {
        font-size: 0.75rem;
      }

      .nested-key {
        font-size: 0.75rem;
      }

      .status-badge {
        font-size: 0.8rem;
        padding: 0.4rem 0.8rem;
      }

      table {
        font-size: 0.9rem;
      }
    }

    @media (max-width: 480px) {
      body {
        padding: 0.25rem;
      }

      .container {
        padding: 0.75rem;
      }

      h1 {
        font-size: 1.25rem;
      }

      th, td {
        padding: 0.4rem;
        font-size: 0.8rem;
      }

      .value-cell {
        font-size: 0.7rem;
      }

      .nested-object {
        margin-left: 0.25rem;
        padding-left: 0.5rem;
      }
    }
  </style>
</head>
  <body>
  <div class="container">
    <div class="header">
      <div class="logo">${LOGO_SVG}</div>
      <h1>API Health Status</h1>
      <span class="status-badge ${statusClass}">${statusDisplay}</span>
    </div>

    <div class="table-wrapper">
      <table>
        <tbody>
          <tr style="border-top: 1px solid #2a2a2a;">
            <td><strong>Version</strong></td>
            <td class="value-cell">
              <div class="nested-object">
                <div class="nested-key">Commit: <span class="nested-value">${data.version.commit}</span></div>
                <div class="nested-key">Environment: <span class="nested-value">${data.version.node_env}</span></div>
              </div>
            </td>
          </tr>
          <tr>
            <td><strong>Links</strong></td>
            <td class="value-cell">
              <div class="nested-object">
                <div class="nested-key"><a href="${data.links.api_documentation}" target="_blank" rel="noopener noreferrer">🔗 API Documentation</a></div>
              </div>
            </td>
          </tr>
          <tr>
            <td><strong>Database</strong></td>
            <td class="value-cell">
              <span class="status-badge ${dbClass}">${dbDisplay}</span>
            </td>
          </tr>
          <tr>
            <td><strong>Redis</strong></td>
            <td class="value-cell">
              ${redisHtml}
            </td>
          </tr>
          <tr>
            <td><strong>Rate Limiting</strong></td>
            <td class="value-cell">
              ${rateLimitHtml}
            </td>
          </tr>
          <tr>
            <td><strong>Arweave</strong></td>
            <td class="value-cell">
              ${arweaveHtml}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="footer">
      <p>Last updated: ${new Date().toLocaleString()}</p>
    </div>
  </div>
</body>
</html>`;
}
