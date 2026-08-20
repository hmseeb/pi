import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import { TOOL_LINK_PREFIX, ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	getToolExecutionCategory,
	TOOL_GROUP_LINK_PREFIX,
	ToolExecutionGroupComponent,
} from "../src/modes/interactive/components/tool-execution-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createFakeViewportTui(): TUI {
	return {
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
		requestRender: () => {},
	} as unknown as TUI;
}

function createShellTool(id: string, command: string, tui: TUI = createFakeTui()): ToolExecutionComponent {
	const component = new ToolExecutionComponent("bash", id, { command }, {}, undefined, tui, process.cwd());
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
	const previousDisableToolLinks = process.env.PI_DISABLE_TOOL_LINKS;

	beforeAll(() => {
		initTheme("dark");
		delete process.env.PI_DISABLE_TOOL_LINKS;
	});

	afterAll(() => {
		if (previousDisableToolLinks === undefined) delete process.env.PI_DISABLE_TOOL_LINKS;
		else process.env.PI_DISABLE_TOOL_LINKS = previousDisableToolLinks;
	});

	test("folds consecutive completed shell calls into a counted summary", () => {
		const group = new ToolExecutionGroupComponent(getToolExecutionCategory("bash", builtinSource), createFakeTui());
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

	test("links the collapsed summary and preserves child links after expanding only that group", () => {
		const tui = createFakeViewportTui();
		const category = getToolExecutionCategory("bash", builtinSource);
		const group = new ToolExecutionGroupComponent(category, tui);
		for (let index = 1; index <= 2; index++) {
			const id = `linked-shell-${index}`;
			const component = createShellTool(id, `echo linked-${index}`, tui);
			group.addTool(id, component);
			completeShellTool(component);
			group.completeTool(id, false);
		}
		const otherGroup = new ToolExecutionGroupComponent(category, tui);
		const otherComponent = createShellTool("other-shell", "echo other", tui);
		otherGroup.addTool("other-shell", otherComponent);
		completeShellTool(otherComponent);
		otherGroup.completeTool("other-shell", false);

		const groupUrl = `${TOOL_GROUP_LINK_PREFIX}${encodeURIComponent("linked-shell-1")}`;
		const collapsed = group.render(120).join("\n");
		expect(collapsed).toContain(`\x1b]8;;${groupUrl}`);
		expect(group.activateLink(groupUrl)).toBe(true);

		const expanded = group.render(120).join("\n");
		expect(stripAnsi(expanded)).toContain("echo linked-1");
		expect(expanded).toContain(`\x1b]8;;${groupUrl}`);
		expect(expanded).toContain(`${TOOL_LINK_PREFIX}linked-shell-1`);
		expect(stripAnsi(otherGroup.render(120).join("\n"))).not.toContain("echo other");
		expect(group.activateLink(groupUrl)).toBe(true);
		expect(stripAnsi(group.render(120).join("\n"))).not.toContain("echo linked-1");
	});

	test("omits group summary links outside viewport mode and in Orca", () => {
		const category = getToolExecutionCategory("bash", builtinSource);
		const plainGroup = new ToolExecutionGroupComponent(category, createFakeTui());
		const plainTool = createShellTool("plain-shell", "echo plain");
		plainGroup.addTool("plain-shell", plainTool);
		completeShellTool(plainTool);
		plainGroup.completeTool("plain-shell", false);
		expect(plainGroup.render(120).join("\n")).not.toContain("\x1b]8;;");

		const previousTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "Orca";
		try {
			const orcaTui = createFakeViewportTui();
			const orcaGroup = new ToolExecutionGroupComponent(category, orcaTui);
			const orcaTool = createShellTool("orca-shell", "echo orca", orcaTui);
			orcaGroup.addTool("orca-shell", orcaTool);
			completeShellTool(orcaTool);
			orcaGroup.completeTool("orca-shell", false);
			expect(orcaGroup.render(120).join("\n")).not.toContain("\x1b]8;;");
		} finally {
			if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = previousTermProgram;
		}
	});

	test("hides pending call details behind a compact running summary", () => {
		const group = new ToolExecutionGroupComponent(getToolExecutionCategory("bash", builtinSource), createFakeTui());
		const complete = createShellTool("shell-complete", "echo done");
		const pending = createShellTool("shell-pending", "sleep 10");
		group.addTool("shell-complete", complete);
		group.addTool("shell-pending", pending);
		completeShellTool(complete);
		group.completeTool("shell-complete", false);

		const running = stripAnsi(group.render(120).join("\n"));
		expect(running).toContain("Running 2 shell commands…");
		expect(running).not.toContain("sleep 10");
		expect(running).not.toContain("echo done");

		group.setExpanded(true);
		const expanded = stripAnsi(group.render(120).join("\n"));
		expect(expanded).toContain("sleep 10");
		expect(expanded).toContain("echo done");

		group.setExpanded(false);
		completeShellTool(pending);
		group.completeTool("shell-pending", false);
		const completed = stripAnsi(group.render(120).join("\n"));
		expect(completed).toContain("Ran 2 shell commands");
		expect(completed).not.toContain("sleep 10");
	});

	test("always includes the failure count in collapsed summaries", () => {
		const group = new ToolExecutionGroupComponent(getToolExecutionCategory("bash", builtinSource), createFakeTui());
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
			runningVerb: "Using",
			singular: "Herdr tool",
			plural: "Herdr tools",
		});

		const group = new ToolExecutionGroupComponent(category, createFakeTui());
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
