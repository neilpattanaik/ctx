import { runBenchmarkCli } from "../../src/perf/benchmark";

if (import.meta.main) {
  runBenchmarkCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Benchmark failed: ${message}`);
      process.exit(1);
    });
}
