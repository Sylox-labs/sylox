#!/usr/bin/env node
// Regenerates lib/contracts/<name>/ for every contract in
// deployments/testnet.json via `stellar contract bindings typescript`.
// Contract IDs are never hardcoded in app code; this script (and the
// generated clients it produces) is the one place that reads them,
// straight from the deployment record.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const appRoot = path.resolve(__dirname, "..");

// deploy/deploy.sh pins this exact version (the real source of truth —
// also recorded per-run in deployments/testnet.json's own
// stellar_cli_version field). Bindings generated with a different CLI
// version aren't guaranteed to match the contracts' actual deployed
// ABI, so this is a hard check, not a warning.
const REQUIRED_STELLAR_CLI_VERSION = "28.1.0";

function die(message) {
  console.error(`generate-bindings: ${message}`);
  process.exit(1);
}

function checkStellarCliVersion() {
  let output;
  try {
    output = execFileSync("stellar", ["--version"], { encoding: "utf8" });
  } catch {
    die(
      "`stellar` CLI not found on PATH. Install stellar-cli " +
        `${REQUIRED_STELLAR_CLI_VERSION} before regenerating bindings.`,
    );
  }
  const match = output.match(/^stellar (\d+\.\d+\.\d+)/m);
  const installed = match?.[1];
  if (installed !== REQUIRED_STELLAR_CLI_VERSION) {
    die(
      `stellar CLI ${installed ?? "(unknown version)"} is installed, but bindings ` +
        `must be generated with ${REQUIRED_STELLAR_CLI_VERSION} (the version ` +
        "deploy/deploy.sh pins). Install the matching version first " +
        "(e.g. `brew upgrade stellar-cli`), rather than generating bindings " +
        "that may not match the deployed contracts' actual ABI.",
    );
  }
}

function loadDeployment() {
  const deploymentPath = path.join(repoRoot, "deployments", "testnet.json");
  if (!existsSync(deploymentPath)) {
    die(`${deploymentPath} not found.`);
  }
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  if (deployment.stellar_cli_version !== REQUIRED_STELLAR_CLI_VERSION) {
    console.warn(
      `generate-bindings: warning: deployments/testnet.json was deployed with ` +
        `stellar-cli ${deployment.stellar_cli_version}, not ` +
        `${REQUIRED_STELLAR_CLI_VERSION}. Proceeding, since the installed CLI ` +
        "version check above is what actually governs bindings generation.",
    );
  }
  return deployment;
}

function generate(name, contractId, outDir) {
  console.log(`generate-bindings: ${name} (${contractId})`);
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  execFileSync(
    "stellar",
    [
      "contract",
      "bindings",
      "typescript",
      "--contract-id",
      contractId,
      "--network",
      "testnet",
      "--output-dir",
      outDir,
      "--overwrite",
    ],
    { stdio: "inherit" },
  );
}

checkStellarCliVersion();
const deployment = loadDeployment();

const targets = {
  "risk-oracle": deployment.contracts?.risk_oracle?.id,
  "event-registry": deployment.contracts?.event_registry?.id,
  // Every Stellar Asset Contract shares the same SEP-41 interface, so
  // bindings generated once from any one of them (TUSD's, here) work
  // as a client for any asset address at runtime - exactly like
  // risk-oracle.ts/event-registry.ts already construct a Client with a
  // runtime contractId from the one set of generated bindings. See
  // lib/contracts/token.ts, the shared client built from this.
  token: deployment.tusd?.contract_id,
};

for (const [name, contractId] of Object.entries(targets)) {
  if (!contractId) {
    die(`deployments/testnet.json has no ${name === "token" ? "tusd.contract_id" : `contracts.${name.replace("-", "_")}.id`} entry.`);
  }
  generate(name, contractId, path.join(appRoot, "lib", "contracts", name));
}

console.log("generate-bindings: done.");
