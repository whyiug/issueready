// @ts-check

/**
 * @param {{ mutate: string; testCommand: string; reportFile: string }} options
 * @returns {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export function createMutationConfig(options) {
  return {
    plugins: [],
    testRunner: "command",
    commandRunner: { command: options.testCommand },
    coverageAnalysis: "off",
    mutate: [options.mutate],
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: options.reportFile },
    clearTextReporter: {
      allowColor: false,
      allowEmojis: false,
      logTests: false,
      maxTestsToLog: 0,
      reportTests: false,
      reportMutants: true,
      reportScoreTable: true,
      skipFull: false,
    },
    allowConsoleColors: false,
    concurrency: 2,
    timeoutMS: 10_000,
    dryRunTimeoutMinutes: 5,
    thresholds: { high: 85, low: 85, break: 85 },
    tempDirName: ".stryker-tmp",
    cleanTempDir: "always",
  };
}
