// Native installs remain host-specific; deployment ZIPs require the Lambda target.
const { header } = process.report.getReport();
if (
  process.platform !== 'linux' ||
  process.arch !== 'x64' ||
  !header.glibcVersionRuntime
) {
  console.error(
    'Media Lambda ZIPs must be built on Linux x64 with glibc. Use a Linux x64 container or the deployment workflow; 6529 ci remains native to your host.'
  );
  process.exit(1);
}
