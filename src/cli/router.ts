import type {
  ParsedAgentsCommand,
  ParsedCommand,
  ParsedExplainCommand,
  ParsedIndexCommand,
  ParsedInitCommand,
  ParsedMainCommand,
  ParsedManifestCommand,
  ParsedOpenCommand,
  ParsedTemplatesCommand,
} from "./parse-args";

export interface CliRuntime {
  stdout(message: string): void;
  stderr(message: string): void;
}

export const DEFAULT_RUNTIME: CliRuntime = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export function handleMainCommand(
  command: ParsedMainCommand,
  runtime: CliRuntime,
): number {
  if (!command.taskText) {
    runtime.stderr("No TASK_TEXT provided. Pass task text or use --help.");
    return 2;
  }

  runtime.stdout(`main pipeline handler pending: ${command.taskText}`);
  return 0;
}

export function handleInitCommand(
  _command: ParsedInitCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout("init handler pending");
  return 0;
}

export function handleAgentsCommand(
  _command: ParsedAgentsCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout("agents handler pending");
  return 0;
}

export function handleIndexCommand(
  command: ParsedIndexCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout(
    command.options.rebuild ? "index rebuild handler pending" : "index status handler pending",
  );
  return 0;
}

export function handleTemplatesCommand(
  command: ParsedTemplatesCommand,
  runtime: CliRuntime,
): number {
  if (command.action === "list") {
    runtime.stdout("templates list handler pending");
    return 0;
  }

  runtime.stdout(`templates show handler pending: ${command.name}`);
  return 0;
}

export function handleExplainCommand(
  command: ParsedExplainCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout(`explain handler pending: ${command.target}`);
  return 0;
}

export function handleManifestCommand(
  command: ParsedManifestCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout(`manifest handler pending: ${command.target}`);
  return 0;
}

export function handleOpenCommand(
  command: ParsedOpenCommand,
  runtime: CliRuntime,
): number {
  runtime.stdout(`open handler pending: ${command.target}`);
  return 0;
}

export function routeCommand(command: ParsedCommand, runtime: CliRuntime): number {
  switch (command.kind) {
    case "main":
      return handleMainCommand(command, runtime);
    case "init":
      return handleInitCommand(command, runtime);
    case "agents":
      return handleAgentsCommand(command, runtime);
    case "index":
      return handleIndexCommand(command, runtime);
    case "templates":
      return handleTemplatesCommand(command, runtime);
    case "explain":
      return handleExplainCommand(command, runtime);
    case "manifest":
      return handleManifestCommand(command, runtime);
    case "open":
      return handleOpenCommand(command, runtime);
    default: {
      const neverValue: never = command;
      runtime.stderr(`Unknown command kind: ${String(neverValue)}`);
      return 2;
    }
  }
}
