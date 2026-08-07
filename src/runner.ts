/**
 * Drives one summoned run.
 *
 * The run is a nested in-process `AgentSession`, not a spawned `pi` child.
 * Measured on this machine at pi 0.83.0: `createAgentSession()` costs 50 ms cold
 * and 16 ms warm in an already-running process, against 560 ms to spawn
 * `node dist/cli.js` — and the 560 ms figure is a floor, taken from the error
 * path before any model or extension setup. `docs/rpc.md:6` recommends the same
 * thing: use `AgentSession` directly rather than a subprocess.
 *
 * In-process also gives us real cancellation (`session.abort()` rather than
 * signalling a process group), exact budget accounting, and no session files to
 * orphan.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	type ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Budget, type BudgetLimits, type ExitReason, type TreeBudget } from "./budget.ts";
import type { RunResult } from "./envelope.ts";
import { appendRecord, createLedger } from "./ledger.ts";
import { MiniResourceLoader } from "./loader.ts";
import { buildSystemPrompt, buildTaskMessage } from "./prompt.ts";
import {
	createLocateTool,
	createShTool,
	createSubmitTool,
	scoutCanServe,
	SH_COMMAND_PREFIX,
	type SubmitDetails,
} from "./tools.ts";

export interface RunOptions {
	task: string;
	contextPack?: string;
	cwd: string;
	limits: BudgetLimits;
	tree: TreeBudget;
	baseDir: string;
	runId: string;
	/** Inherited from the caller so a summoned run bills and behaves predictably. */
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	/** Read-only runs get no write/edit path; `sh` is still granted, so this is advisory. */
	retrieval: "auto" | "off";
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

export async function runMiniAgent(options: RunOptions): Promise<RunResult> {
	const ledger = createLedger(options.baseDir, options.runId);
	const budget = new Budget(options.limits, options.tree);

	const hasLocate = options.retrieval === "auto" && (await scoutCanServe(options.cwd));

	let submitted: SubmitDetails | undefined;
	let sessionRef: AgentSession | undefined;
	let stopReason: ExitReason | undefined;

	/**
	 * The pre-spend gate.
	 *
	 * `before_provider_request` fires after the payload is serialized and before
	 * the HTTP call — the only checkpoint pi offers that is genuinely ahead of
	 * spend. Checking after a turn instead would let one oversized request blow
	 * the budget by an unbounded amount, since a 900k-token prompt is still just
	 * "one step".
	 *
	 * We both abort the session and throw: the abort stops the loop, and the
	 * throw stops *this* request even if the runner swallows handler errors.
	 * Worst case the overrun is bounded to a single request.
	 */
	const gate = {
		event: "before_provider_request",
		handler: () => {
			const stop = budget.checkBeforeCall();
			if (stop) {
				stopReason ??= stop;
				appendRecord(ledger.transcript, { type: "budget_stop", reason: stop, ...budget.snapshot() });
				void sessionRef?.abort();
				throw new Error(`mini-agent budget stop: ${stop}`);
			}
			budget.countStep();
			options.onProgress?.(`step ${budget.steps}/${budget.limits.steps} · $${budget.usd.toFixed(3)}`);
			return undefined;
		},
	};

	const tools: ToolDefinition[] = [
		createShTool({ cwd: options.cwd, budget, ledger, commandPrefix: SH_COMMAND_PREFIX }),
		createSubmitTool((details) => {
			submitted = details;
		}),
	];
	if (hasLocate) tools.push(createLocateTool(options.cwd));

	const systemPrompt = buildSystemPrompt({
		limits: options.limits,
		hasLocate,
		cwd: options.cwd,
	});

	const { session } = await createAgentSession({
		cwd: options.cwd,
		model: options.model,
		modelRuntime: options.modelRuntime,
		sessionManager: SessionManager.inMemory(),
		resourceLoader: new MiniResourceLoader({ systemPrompt, handlers: [gate] }),
		customTools: tools,
		// Closed toolset: only what this runtime registered. No read/edit/write/
		// grep/find/ls, so there is exactly one way to act.
		noTools: "all",
		tools: tools.map((tool) => tool.name),
	});
	sessionRef = session;

	// Charge spend as it is observed, and keep a full local transcript.
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_end") return;
		const message = event.message as {
			role?: string;
			usage?: { cost?: { total?: number } };
		};
		if (message.role === "assistant" && message.usage?.cost?.total) {
			budget.charge(message.usage.cost.total);
		}
		appendRecord(ledger.transcript, { type: "message", message: event.message });
	});

	const onAbort = () => {
		stopReason ??= "aborted";
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let error: string | undefined;
	try {
		await session.prompt(buildTaskMessage(options.task, options.contextPack));
	} catch (cause) {
		// A budget stop surfaces here as the gate's throw; that is expected control
		// flow, not a failure to report.
		if (!stopReason && !budget.tripped) {
			error = cause instanceof Error ? cause.message : String(cause);
			stopReason = "error";
		}
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		try {
			session.dispose();
		} catch {
			// disposal must never mask the result
		}
	}

	const exitReason: ExitReason = submitted
		? "submitted"
		: (budget.tripped ?? stopReason ?? "error");

	const result: RunResult = {
		exitReason,
		summary: submitted?.summary ?? fallbackSummary(session, exitReason),
		filesChanged: submitted?.filesChanged ?? [],
		budget: budget.snapshot(),
		ledgerDir: ledger.dir,
		steps: budget.steps,
		costUsd: budget.usd,
		...(error ? { error } : {}),
	};

	appendRecord(ledger.transcript, { type: "result", result });
	return result;
}

/**
 * When a run ends without submitting, salvage the last assistant text.
 *
 * This is explicitly a fallback, never the primary path — scraping the last
 * message is exactly the unreliable behaviour the `submit` contract exists to
 * replace, and the envelope labels such results as partial.
 */
function fallbackSummary(session: AgentSession, reason: ExitReason): string {
	const messages = session.messages as Array<{
		role?: string;
		content?: unknown;
	}>;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = extractText(message.content);
		if (text) return `(no submit call; stopped on "${reason}") Last assistant output:\n\n${text}`;
	}
	return `(no result reported; stopped on "${reason}")`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			const candidate = block as { type?: string; text?: unknown };
			return candidate?.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}
