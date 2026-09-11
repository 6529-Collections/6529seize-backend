// Native installs remain host-specific; deployment ZIPs require the Lambda target.
function isLambdaBuildHost() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return false;
  try {
    return Boolean(process.report?.getReport().header.glibcVersionRuntime);
  } catch {
    return false;
  }
}
if (!isLambdaBuildHost()) {
  console.error(
    'Media Lambda ZIPs must be built on Linux x64 with glibc. Use a Linux x64 container or the deployment workflow; 6529 ci remains native to your host.'
  );
  process.exit(1);
}
