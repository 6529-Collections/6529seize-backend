const RAW_BODY_PATHS = new Set(['/gh-hooks', '/dev-alerts']);

export function shouldCaptureRawBody(requestUrl?: string): boolean {
  const path = (requestUrl ?? '').split('?')[0];
  return (
    RAW_BODY_PATHS.has(path) ||
    path === '/ci-pipeline-alerts' ||
    path.startsWith('/ci-pipeline-alerts/')
  );
}
