// Stand-in for the `esbuild` module while the drift tool evaluates a
// service's esbuild config file. It records the options passed to build()
// instead of building, so the tool can run the same build in memory.
export async function build(options) {
  const sink = globalThis.__deployTrainEsbuildCapture;
  if (!Array.isArray(sink)) {
    throw new Error('esbuild option capture is not active');
  }
  sink.push(options);
  return { errors: [], warnings: [], outputFiles: [] };
}

export default { build };
