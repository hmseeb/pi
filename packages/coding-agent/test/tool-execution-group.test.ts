import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	getToolExecutionCategory,
	ToolExecutionGroupComponent,
} from "../src/modes/interactive/components/tool-execution-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createShellTool(id: string, command: string): ToolExecutionComponent {
	const component = new ToolExecutionComponent("bash", id, { command }, {}, undefined, createFakeTui(), process.cwd());
	component.markExecutionStarted();
	return component;
}

function completeShellTool(component: ToolExecutionComponent, isError = false): void {
	component.updateResult(
		{
			content: [{ type: "text", text: isError ? "command failed" : "command output" }],
			isError,
		},
		false,
	);
}

const builtinSource: SourceInfo = {
	path: "<builtin:bash>",
	source: "builtin",
	scope: "temporary",
	origin: "top-level",
};

describe("ToolExecutionGroupComponent", () => {
	beforeAll(() => initTheme("dark"));

	test("folds consecutive completed shell calls into a counted summary", () => {
		const group = new ToolExecutionGroupComponent(getToolExecutionCategory("bash", builtinSource));
		for (let index = 1; index <= 3; index++) {
			const id = `shell-${index}`;
			const component = createShellTool(id, `echo ${index}`);
			group.addTool(id, component);
			completeShellTool(component);
			group.completeTool(id, false);
		}

		const collapsed = stripAnsi(group.render(120).join("\n"));
		expect(collapsed).toContain("Ran 3 shell commands");
		expect(collapsed).not.toContain("echo 1");
		expect(collapsed).not.toContain("command output");

		group.setExpanded(true);
		const expanded = stripAnsi(group.render(120).join("\n"));
		expect(expanded).toContain("echo 1");
		expect(expanded).toContain("echo 3");
		expect(expanded).toContain("command output");
	});

	test("keeps pending calls visible while folding completed calls", () => {
		const group = new ToolExecutionGroupComponent(getToolExecutionCategory("bash", builtinSource));
		const complete = createShellTool("shell-complete", "echo done");
		const pending = createShellTool("shell-pending", "sleep 10");
		group.addTool("shell-complete", complete);
		group.addTool("shell-pending", pending);
		completeShellTool(complete);
		group.completeTool("shell-complete", false);

		const running = stripAnsi(group.render(120).join("\n"));
		expect(running).toContain("Ran 1 shell command");
		expect(running).toContain("sleep 10");
		expect(running).not.toContain("echo done");

		completeShellTool(pending);
		group.completeTool("shell-pending", false);
		const completed = stripAnsi(group.render(120).join("\n"));
		expect(completed).toContain("Ran 2 shell commands");
		expect(completed).not.toContain("sleep 10");
	});

	test("always includes the failure count in collapsed summaries", () => {
		const group = new ToolExecutionGroupComponent(getToolExecutionCategory("bash", builtinSource));
		for (let index = 1; index <= 3; index++) {
			const id = `shell-${index}`;
			const component = createShellTool(id, `command ${index}`);
			group.addTool(id, component);
			completeShellTool(component, index === 2);
			group.completeTool(id, index === 2);
		}

		expect(stripAnsi(group.render(120).join("\n"))).toContain("1 of 3 failed");
	});

	test("derives a compact custom-tool category from package source metadata", () => {
		const category = getToolExecutionCategory("herdr_workflow", {
			path: "/tmp/node_modules/pi-herdr-agents/pi-extension/index.ts",
			source: "npm:pi-herdr-agents",
			scope: "user",
			origin: "package",
		});
		expect(category).toEqual({
			key: "npm:pi-herdr-agents:/tmp/node_modules/pi-herdr-agents/pi-extension/index.ts",
			verb: "Used",
			singular: "Herdr tool",
			plural: "Herdr tools",
		});

		const group = new ToolExecutionGroupComponent(category);
		for (let index = 1; index <= 2; index++) {
			const id = `herdr-${index}`;
			const component = new ToolExecutionComponent(
				"herdr_workflow",
				id,
				{},
				{},
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			group.addTool(id, component);
			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			group.completeTool(id, false);
		}
		expect(stripAnsi(group.render(120).join("\n"))).toContain("Used 2 Herdr tools");
	});
});
