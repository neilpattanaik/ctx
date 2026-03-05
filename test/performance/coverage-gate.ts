import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface CoverageMetrics {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

interface GlobalCoverageThresholds {
  line: number;
  functions: number;
}

interface NextStageTargets {
  line?: number;
  functions?: number;
}

interface LaneCoverageThresholds {
  global: GlobalCoverageThresholds;
  module_line_floors?: Record<string, number>;
  next_stage_targets?: NextStageTargets;
}

interface CoverageThresholdConfig {
  lanes: Record<string, LaneCoverageThresholds>;
}

interface ParsedArgs {
  lane: string;
  lcovPath: string;
  configPath: string;
}

const DEFAULT_CONFIG_PATH = "test/performance/coverage-thresholds.json";

function renderHelp(): string {
  return [
    "coverage gate",
    "",
    "Usage:",
    "  bun run test/performance/coverage-gate.ts --lane <lane> --lcov <path> [--config <path>]",
    "",
    "Options:",
    "  --lane <name>     Coverage lane key from threshold config (required)",
    "  --lcov <path>     LCOV file path to evaluate (required)",
    `  --config <path>   Threshold config JSON (default: ${DEFAULT_CONFIG_PATH})`,
    "  --help            Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: ParsedArgs = {
    lane: "",
    lcovPath: "",
    configPath: DEFAULT_CONFIG_PATH,
  };

  const readValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      throw new Error("HELP");
    }
    if (token === "--lane") {
      options.lane = readValue(index, "--lane");
      index += 1;
      continue;
    }
    if (token.startsWith("--lane=")) {
      options.lane = token.slice("--lane=".length);
      continue;
    }
    if (token === "--lcov") {
      options.lcovPath = readValue(index, "--lcov");
      index += 1;
      continue;
    }
    if (token.startsWith("--lcov=")) {
      options.lcovPath = token.slice("--lcov=".length);
      continue;
    }
    if (token === "--config") {
      options.configPath = readValue(index, "--config");
      index += 1;
      continue;
    }
    if (token.startsWith("--config=")) {
      options.configPath = token.slice("--config=".length);
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  if (!options.lane) {
    throw new Error("--lane is required");
  }
  if (!options.lcovPath) {
    throw new Error("--lcov is required");
  }
  return options;
}

function createEmptyMetrics(): CoverageMetrics {
  return {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
  };
}

function readNonNegativeNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return input;
}

function readPercentThreshold(input: unknown, field: string): number {
  const value = readNonNegativeNumber(input, field);
  if (value > 100) {
    throw new Error(`${field} must be <= 100`);
  }
  return value;
}

function parseThresholdConfig(rawText: string): CoverageThresholdConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Failed to parse threshold config JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("lanes" in parsed) ||
    !parsed.lanes ||
    typeof parsed.lanes !== "object"
  ) {
    throw new Error("Threshold config must contain a lanes object");
  }

  const lanes: Record<string, LaneCoverageThresholds> = {};
  for (const [laneName, laneConfig] of Object.entries(parsed.lanes as Record<string, unknown>)) {
    if (!laneConfig || typeof laneConfig !== "object") {
      throw new Error(`Lane config must be an object: ${laneName}`);
    }
    if (!("global" in laneConfig) || !laneConfig.global || typeof laneConfig.global !== "object") {
      throw new Error(`Lane config missing global thresholds: ${laneName}`);
    }

    const globalThresholds = laneConfig.global as Record<string, unknown>;
    const global: GlobalCoverageThresholds = {
      line: readPercentThreshold(globalThresholds.line, `${laneName}.global.line`),
      functions: readPercentThreshold(
        globalThresholds.functions,
        `${laneName}.global.functions`,
      ),
    };

    const normalizedLane: LaneCoverageThresholds = { global };
    if ("module_line_floors" in laneConfig && laneConfig.module_line_floors !== undefined) {
      if (
        !laneConfig.module_line_floors ||
        typeof laneConfig.module_line_floors !== "object"
      ) {
        throw new Error(`${laneName}.module_line_floors must be an object`);
      }

      const moduleLineFloors: Record<string, number> = {};
      for (const [prefix, threshold] of Object.entries(
        laneConfig.module_line_floors as Record<string, unknown>,
      )) {
        if (!prefix) {
          throw new Error(`${laneName}.module_line_floors contains empty prefix`);
        }
        moduleLineFloors[prefix] = readPercentThreshold(
          threshold,
          `${laneName}.module_line_floors.${prefix}`,
        );
      }
      normalizedLane.module_line_floors = moduleLineFloors;
    }

    if ("next_stage_targets" in laneConfig && laneConfig.next_stage_targets !== undefined) {
      if (!laneConfig.next_stage_targets || typeof laneConfig.next_stage_targets !== "object") {
        throw new Error(`${laneName}.next_stage_targets must be an object`);
      }
      const nextStageInput = laneConfig.next_stage_targets as Record<string, unknown>;
      const nextStageTargets: NextStageTargets = {};
      if (nextStageInput.line !== undefined) {
        nextStageTargets.line = readPercentThreshold(
          nextStageInput.line,
          `${laneName}.next_stage_targets.line`,
        );
      }
      if (nextStageInput.functions !== undefined) {
        nextStageTargets.functions = readPercentThreshold(
          nextStageInput.functions,
          `${laneName}.next_stage_targets.functions`,
        );
      }
      normalizedLane.next_stage_targets = nextStageTargets;
    }

    lanes[laneName] = normalizedLane;
  }

  return { lanes };
}

function parseLcov(rawText: string): Map<string, CoverageMetrics> {
  const metricsByFile = new Map<string, CoverageMetrics>();
  let currentFile: string | null = null;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("SF:")) {
      currentFile = line.slice("SF:".length);
      if (!metricsByFile.has(currentFile)) {
        metricsByFile.set(currentFile, createEmptyMetrics());
      }
      continue;
    }
    if (!currentFile) {
      continue;
    }

    const metrics = metricsByFile.get(currentFile);
    if (!metrics) {
      continue;
    }

    if (line.startsWith("LF:")) {
      metrics.linesFound = readNonNegativeNumber(
        Number.parseInt(line.slice("LF:".length), 10),
        `LF(${currentFile})`,
      );
      continue;
    }
    if (line.startsWith("LH:")) {
      metrics.linesHit = readNonNegativeNumber(
        Number.parseInt(line.slice("LH:".length), 10),
        `LH(${currentFile})`,
      );
      continue;
    }
    if (line.startsWith("FNF:")) {
      metrics.functionsFound = readNonNegativeNumber(
        Number.parseInt(line.slice("FNF:".length), 10),
        `FNF(${currentFile})`,
      );
      continue;
    }
    if (line.startsWith("FNH:")) {
      metrics.functionsHit = readNonNegativeNumber(
        Number.parseInt(line.slice("FNH:".length), 10),
        `FNH(${currentFile})`,
      );
    }
  }

  if (metricsByFile.size === 0) {
    throw new Error("LCOV file did not contain any SF records");
  }
  return metricsByFile;
}

function sumCoverageMetrics(values: Iterable<CoverageMetrics>): CoverageMetrics {
  const total = createEmptyMetrics();
  for (const metrics of values) {
    total.linesFound += metrics.linesFound;
    total.linesHit += metrics.linesHit;
    total.functionsFound += metrics.functionsFound;
    total.functionsHit += metrics.functionsHit;
  }
  return total;
}

function toPercent(hit: number, found: number): number {
  if (found === 0) {
    return 100;
  }
  return (hit / found) * 100;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function evaluateLaneCoverage(
  laneName: string,
  laneConfig: LaneCoverageThresholds,
  metricsByFile: Map<string, CoverageMetrics>,
): string[] {
  const failures: string[] = [];
  const totals = sumCoverageMetrics(metricsByFile.values());
  const linePercent = toPercent(totals.linesHit, totals.linesFound);
  const functionPercent = toPercent(totals.functionsHit, totals.functionsFound);

  console.log(
    `[coverage] lane=${laneName} lines=${formatPercent(linePercent)} (${totals.linesHit}/${totals.linesFound}) target>=${laneConfig.global.line.toFixed(2)}%`,
  );
  console.log(
    `[coverage] lane=${laneName} functions=${formatPercent(functionPercent)} (${totals.functionsHit}/${totals.functionsFound}) target>=${laneConfig.global.functions.toFixed(2)}%`,
  );

  if (linePercent < laneConfig.global.line) {
    failures.push(
      `global line coverage ${formatPercent(linePercent)} is below ${laneConfig.global.line.toFixed(2)}%`,
    );
  }
  if (functionPercent < laneConfig.global.functions) {
    failures.push(
      `global function coverage ${formatPercent(functionPercent)} is below ${laneConfig.global.functions.toFixed(2)}%`,
    );
  }

  const moduleFloors = laneConfig.module_line_floors ?? {};
  for (const [prefix, threshold] of Object.entries(moduleFloors)) {
    const matchingMetrics = [...metricsByFile.entries()]
      .filter(([filePath]) => filePath.startsWith(prefix))
      .map(([, metrics]) => metrics);
    if (matchingMetrics.length === 0) {
      failures.push(`module floor prefix '${prefix}' matched zero files`);
      continue;
    }

    const moduleTotals = sumCoverageMetrics(matchingMetrics);
    const moduleLinePercent = toPercent(moduleTotals.linesHit, moduleTotals.linesFound);
    console.log(
      `[coverage] lane=${laneName} module=${prefix} lines=${formatPercent(moduleLinePercent)} (${moduleTotals.linesHit}/${moduleTotals.linesFound}) target>=${threshold.toFixed(2)}%`,
    );

    if (moduleLinePercent < threshold) {
      failures.push(
        `module '${prefix}' line coverage ${formatPercent(moduleLinePercent)} is below ${threshold.toFixed(2)}%`,
      );
    }
  }

  if (laneConfig.next_stage_targets) {
    const nextLine = laneConfig.next_stage_targets.line;
    const nextFunctions = laneConfig.next_stage_targets.functions;
    const parts: string[] = [];
    if (nextLine !== undefined) {
      parts.push(`line>=${nextLine.toFixed(2)}%`);
    }
    if (nextFunctions !== undefined) {
      parts.push(`functions>=${nextFunctions.toFixed(2)}%`);
    }
    if (parts.length > 0) {
      console.log(`[coverage] lane=${laneName} next_stage_targets: ${parts.join(", ")}`);
    }
  }

  return failures;
}

function runCoverageGate(argv: string[]): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      console.log(renderHelp());
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Use --help for options.");
    return 2;
  }

  try {
    const configText = readFileSync(resolve(args.configPath), "utf8");
    const config = parseThresholdConfig(configText);
    const laneConfig = config.lanes[args.lane];
    if (!laneConfig) {
      throw new Error(`Lane '${args.lane}' not found in threshold config`);
    }

    const lcovText = readFileSync(resolve(args.lcovPath), "utf8");
    const metricsByFile = parseLcov(lcovText);
    const failures = evaluateLaneCoverage(args.lane, laneConfig, metricsByFile);
    if (failures.length > 0) {
      console.error(`[coverage] lane=${args.lane} gate failed (${failures.length} issue(s))`);
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      return 1;
    }
    console.log(`[coverage] lane=${args.lane} gate passed`);
    return 0;
  } catch (error) {
    console.error(`[coverage] gate error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  const exitCode = runCoverageGate(process.argv.slice(2));
  process.exit(exitCode);
}
