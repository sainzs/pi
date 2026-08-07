/**
 * The acceptance predicate — verification moved from discipline into the contract.
 *
 * The single biggest failure mode observed across harnesses (this repo's own
 * design notes, and a 2026-08-07 multi-agent reorg run) is a child that reports
 * "completed" having done nothing, or reports file changes that never happened.
 * The fix is structural: the CALLER declares, before the run starts, a shell
 * command whose exit code defines "done". The HARNESS runs it after the child
 * submits — in the same cwd, with a hard timeout — and attaches the verdict to
 * the envelope. The child's summary is never surfaced without it.
 *
 * The predicate is also shown to the child in its task message. That is not a
 * leak; it is the point. A machine-checkable definition of done is the cheapest
 * possible alignment between caller and child, and the child running it before
 * submitting converts "I think I'm done" into "the caller's own check passes".
 *
 * What this deliberately is NOT: a sandbox. The child could craft a state that
 * passes the predicate without doing the work. The predicate bounds *negligence
 * and self-deception*, which are the observed failure modes; it does not bound
 * adversarial children, which are a model-quality problem no post-hoc check
 * solves.
 */

import { execFile } from "node:child_process";

const OUTPUT_CAP = 800;
/** Predicates are gates, not builds. A slow predicate is a design smell. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface Verification {
	command: string;
	/** null when the predicate itself could not run (timeout, spawn failure). */
	exitCode: number | null;
	ok: boolean;
	/** Combined stdout+stderr, capped. */
	output: string;
}

export function runAcceptance(
	command: string,
	cwd: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Verification> {
	return new Promise((resolve) => {
		execFile(
			"bash",
			["-c", command],
			{ cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const combined = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
				const output =
					combined.length > OUTPUT_CAP
						? `${combined.slice(0, OUTPUT_CAP)}\n[... ${combined.length - OUTPUT_CAP} chars truncated]`
						: combined;
				if (!error) {
					resolve({ command, exitCode: 0, ok: true, output });
					return;
				}
				const code = typeof (error as { code?: unknown }).code === "number"
					? ((error as { code: number }).code)
					: null;
				const timedOut = (error as { killed?: boolean }).killed === true && code === null;
				resolve({
					command,
					exitCode: code,
					ok: false,
					output: timedOut ? `[predicate timed out after ${timeoutMs}ms] ${output}` : output,
				});
			},
		);
	});
}
