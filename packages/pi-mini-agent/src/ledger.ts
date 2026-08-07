/**
 * The observation ledger.
 *
 * mini-swe-agent's append-only transcript means every step resends everything
 * before it, so cost grows quadratically in step count. With prompt caching the
 * quadratic term is billed at the cache-read rate (0.1×), which makes it
 * survivable — but the coefficient still scales with how much text each step
 * appends, and a single 50 KB command output appended at step 5 is re-read on
 * every one of the remaining steps.
 *
 * So: every raw observation is written to disk in full, and only a bounded
 * digest enters the transcript. The agent re-opens the full text by path when it
 * actually needs it. "Resend forever" becomes "pay once, re-read on demand".
 *
 * We do the truncation ourselves rather than calling `scout compress`: measured
 * on scout 0.9.120, `compress` is a silent pass-through above exactly 100,000
 * bytes of input — a no-op precisely in the case that motivates it — and it is
 * lossy in a way that destroys grep hits below that threshold.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Head + tail budget for an observation kept in context. */
const HEAD_CHARS = 2_500;
const TAIL_CHARS = 1_500;
const ELIDE_THRESHOLD = HEAD_CHARS + TAIL_CHARS;

export interface RunLedger {
	runId: string;
	dir: string;
	/** Absolute path of the NDJSON transcript for this run. */
	transcript: string;
}

export function createLedger(baseDir: string, runId: string): RunLedger {
	const dir = join(baseDir, "runs", runId);
	mkdirSync(join(dir, "obs"), { recursive: true });
	return { runId, dir, transcript: join(dir, "transcript.ndjson") };
}

/**
 * Persist a full observation and return the bounded form for the transcript.
 *
 * The elision marker states the exact number of dropped characters and the file
 * to read, which is what makes it actionable rather than merely honest.
 */
export function recordObservation(ledger: RunLedger, step: number, raw: string): string {
	if (raw.length <= ELIDE_THRESHOLD) return raw;

	const path = join(ledger.dir, "obs", `${String(step).padStart(3, "0")}.txt`);
	try {
		writeFileSync(path, raw, "utf-8");
	} catch {
		// A ledger write failure must never fail the step; fall back to a plain
		// truncation with no file reference.
		const droppedNoFile = raw.length - ELIDE_THRESHOLD;
		return [
			raw.slice(0, HEAD_CHARS),
			`\n\n<elided_chars>${droppedNoFile} characters elided; full output unavailable</elided_chars>\n\n`,
			raw.slice(-TAIL_CHARS),
		].join("");
	}

	const dropped = raw.length - ELIDE_THRESHOLD;
	return [
		raw.slice(0, HEAD_CHARS),
		`\n\n<elided_chars>${dropped} characters elided. Full ${raw.length}-char output: ${path}`,
		` — re-read with \`sed -n 'START,ENDp' ${path}\` or \`rg PATTERN ${path}\`</elided_chars>\n\n`,
		raw.slice(-TAIL_CHARS),
	].join("");
}

/** Append one NDJSON record. Never throws — observability must not break a run. */
export function appendRecord(path: string, record: unknown): void {
	try {
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
	} catch {
		// ignore
	}
}

/**
 * Append to the cross-run audit log: one line per summon, ever. Cheap, and the
 * only thing standing between a dynamically composed agent tree and total loss
 * of visibility into what ran.
 */
export function auditSummon(baseDir: string, record: Record<string, unknown>): void {
	try {
		mkdirSync(baseDir, { recursive: true });
	} catch {
		return;
	}
	appendRecord(join(baseDir, "audit.ndjson"), { ts: new Date().toISOString(), ...record });
}
