#!/usr/bin/env bun

import {
  DEFAULT_RUNTIME,
  parseCliArgs,
  renderHelp,
  routeCommand,
  type CliRuntime,
} from "./cli";

export function run(argv: string[], runtime: CliRuntime = DEFAULT_RUNTIME): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    runtime.stderr(parsed.error);
    return parsed.exitCode;
  }

  if (parsed.value.options.help) {
    runtime.stdout(renderHelp());
    return 0;
  }

  return routeCommand(parsed.value, runtime);
}

if (import.meta.main) {
  const exitCode = run(process.argv.slice(2));
  process.exit(exitCode);
}
