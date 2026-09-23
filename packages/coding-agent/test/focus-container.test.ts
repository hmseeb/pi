import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { FocusContainer } from "../src/modes/interactive/components/focus-container.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const assistant = (text: string) =>
	new AssistantMessageComponent({
		role: "assistant",
		content: text ? [{ type: "text", text }] : [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage);

const tool = (name: string) =>
	Object.assign(Object.create(ToolExecutionComponent.prototype), {
		toolName: name,
		render: () => [`TOOL ${name}`],
	}) as ToolExecutionComponent;

test("focus view collapses tools and intermediate messages per prompt", () => {
	initTheme("dark");
	const c = new FocusContainer();
	for (const child of [
		new UserMessageComponent("first prompt"),
		assistant("let me look"),
		tool("read"),
		tool("read"),
		assistant(""),
		tool("bash"),
		assistant("final answer"),
		new Text("custom note"),
		new UserMessageComponent("second prompt"),
		tool("edit"),
	])
		c.addChild(child);

	const full = stripAnsi(c.render(80).join("\n"));
	expect(full).toContain("TOOL read");
	expect(full).toContain("let me look");

	c.focus = true;
	const out = stripAnsi(c.render(80).join("\n"));
	expect(out).not.toContain("TOOL");
	expect(out).not.toContain("let me look");
	expect(out).toContain("⋯ 3 tool calls · read ×2, bash");
	expect(out).toContain("final answer");
	expect(out).toContain("custom note");
	expect(out).toContain("second prompt");
	expect(out).toContain("⋯ 1 tool call · edit");
	expect(out.indexOf("⋯ 3")).toBeLessThan(out.indexOf("final answer"));
});
