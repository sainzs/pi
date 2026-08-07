/**
 * Live smoke for the verification contract (v0.2). Costs real (tiny) money.
 *
 *   node --experimental-strip-types scripts/smoke-contract.ts [provider/model]
 *
 * Proves the two things unit tests cannot:
 *  1. HAPPY PATH — a real model completes a leased, predicated task: the
 *     harness OBSERVES the file change via git (not the model's claim), the
 *     acceptance predicate passes, the envelope is success.
 *  2. PREDICATE AUTHORITY — a submitted run whose predicate fails (`false`,
 *     unsatisfiable by construction) yields a FAILURE envelope no matter how
 *     confident the child's summary is.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TreeBudget } from "../src/budget.ts";
import { formatEnvelope, isFailure } from "../src/envelope.ts";
import { runMiniAgent } from "../src/runner.ts";

const target = process.argv[2] ?? "azure/gpt-5.6-sol";
const [provider, ...rest] = target.split("/");
const modelId = rest.join("/");

const runtime = await ModelRuntime.create();
const model = runtime.getModel(provider!, modelId);
if (!model) {
	console.error(`no such model: ${target}`);
	process.exit(1);
}
console.log(`model: ${provider}/${modelId}\n`);

function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "mini-contract-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	git("init", "-b", "main", "-q");
	git("config", "user.email", "smoke@local");
	git("config", "user.name", "smoke");
	writeFileSync(join(dir, "README.md"), "fixture repo\n");
	git("add", "-A");
	git("commit", "-qm", "base");
	return dir;
}

const baseDir = mkdtempSync(join(tmpdir(), "mini-contract-ledger-"));
const tree = new TreeBudget(3);

// --- 1. Happy path: lease + predicate, observed not claimed -------------------
console.log("--- run 1: leased + predicated happy path ---");
const repo1 = tempRepo();
const ok = await runMiniAgent({
	task:
		"Create a file named greeting.txt containing exactly the line 'hello world' (no trailing " +
		"spaces). Verify it, then submit.",
	cwd: repo1,
	limits: { steps: 8, usd: 1, wallMs: 5 * 60_000 },
	tree,
	baseDir,
	runId: "contract1",
	model,
	modelRuntime: runtime,
	retrieval: "off",
	accept: "grep -qx 'hello world' greeting.txt",
	lease: ["greeting.txt"],
	onProgress: (text) => console.log(`  ${text}`),
});
console.log(`\n${formatEnvelope(ok)}\n`);
assert.equal(ok.exitReason, "submitted", "run 1 must submit");
assert.ok(ok.verification, "predicate must have been executed by the harness");
assert.equal(ok.verification!.ok, true, "predicate must pass");
assert.equal(ok.filesChangedSource, "observed", "file changes must come from git observation");
assert.deepEqual(ok.filesChanged, ["greeting.txt"], "observed set must be exactly the artifact");
assert.equal(ok.leaseViolations, undefined, "no out-of-lease writes");
assert.equal(isFailure(ok), false, "envelope must be success");

// --- 2. Predicate authority: submitted != success ------------------------------
console.log("--- run 2: unsatisfiable predicate fails a submitted run ---");
const ko = await runMiniAgent({
	task:
		"Do not create or modify any file. Submit immediately with the summary 'noop complete'. " +
		"The acceptance predicate is intentionally unsatisfiable; do not try to make it pass.",
	cwd: tempRepo(),
	limits: { steps: 4, usd: 0.5, wallMs: 3 * 60_000 },
	tree,
	baseDir,
	runId: "contract2",
	model,
	modelRuntime: runtime,
	retrieval: "off",
	accept: "false",
	lease: [],
	onProgress: (text) => console.log(`  ${text}`),
});
console.log(`\n${formatEnvelope(ko)}\n`);
assert.equal(ko.exitReason, "submitted", "run 2 should still submit");
assert.equal(ko.verification!.ok, false, "the unsatisfiable predicate must fail");
assert.equal(isFailure(ko), true, "a submitted run with a failing predicate is a FAILURE");

console.log(`tree spend: $${tree.spentUsd.toFixed(4)} of $${tree.ceilingUsd.toFixed(2)}`);
console.log(`ledgers under: ${baseDir}`);
console.log("\ncontract smoke passed");
