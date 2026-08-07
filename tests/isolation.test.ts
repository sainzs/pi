/**
 * The fork-bomb regression test.
 *
 * A summoned run must not be able to summon. The mechanism is not a depth
 * counter — it is that a summoned run receives a closed resource set with no
 * discovered extensions, so the `mini` tool is never registered inside it.
 *
 * This test asserts both halves: that pi's default discovery really would load
 * the parent's extensions into a nested session (the hazard), and that
 * `MiniResourceLoader` does not (the fix). If pi ever changes such that the first
 * assertion fails, the hazard is gone and this test should be revisited — but a
 * silent change in the *other* direction is what would be dangerous, and that is
 * what the second assertion pins down.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MiniResourceLoader } from "../src/loader.ts";

const cwd = process.cwd();
const agentDir = `${process.env.HOME}/.pi/agent`;

test("pi's default discovery would load ambient extensions into a nested session", async () => {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await loader.reload();

	const discovered = loader.getExtensions().extensions.length;
	const skills = loader.getSkills().skills.length;

	// This is the hazard, stated as a fact about this machine rather than a belief:
	// anything discoverable here would be inherited by a nested session that used
	// the default loader.
	assert.ok(
		discovered > 0 || skills > 0,
		`expected ambient resources to exist (found ${discovered} extensions, ${skills} skills)`,
	);
});

test("MiniResourceLoader hands a summoned run a closed resource set", async () => {
	const loader = new MiniResourceLoader({ systemPrompt: "test prompt", handlers: [] });
	await loader.reload();

	assert.deepEqual(loader.getExtensions().extensions, [], "no extensions — this is the fork-bomb fix");
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.deepEqual(loader.getSkills().skills, [], "no skills — no harness chatter");
	assert.deepEqual(loader.getPrompts().prompts, []);
	assert.deepEqual(loader.getThemes().themes, []);
	assert.deepEqual(
		loader.getAgentsFiles().agentsFiles,
		[],
		"no AGENTS.md — 11KB of repo constitution must not enter a brief-scoped run",
	);
	assert.equal(loader.getSystemPrompt(), "test prompt");
	assert.deepEqual(loader.getAppendSystemPrompt(), [], "nothing may be appended to the prompt");

	// A closed set must stay closed even if something tries to widen it.
	loader.extendResources();
	await loader.reload();
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
});

test("the injected budget gate is the only handler a summoned run gets", () => {
	const calls: string[] = [];
	const loader = new MiniResourceLoader({
		systemPrompt: "p",
		handlers: [
			{
				event: "before_provider_request",
				handler: () => {
					calls.push("gate");
					return undefined;
				},
			},
		],
	});

	const { extensions } = loader.getExtensions();
	assert.equal(extensions.length, 1, "exactly one synthesized extension");

	const extension = extensions[0];
	assert.ok(extension);
	assert.equal(extension.hidden, true, "the gate must not appear in user-facing extension listings");
	assert.equal(extension.tools.size, 0, "the gate registers no tools");
	assert.equal(extension.commands.size, 0);
	assert.equal(extension.flags.size, 0);
	assert.equal(extension.shortcuts.size, 0);

	assert.deepEqual([...extension.handlers.keys()], ["before_provider_request"]);
	const handlers = extension.handlers.get("before_provider_request");
	assert.equal(handlers?.length, 1);

	// The handler pi would invoke is the one we passed.
	handlers?.[0]?.({} as never, {} as never);
	assert.deepEqual(calls, ["gate"]);
});
