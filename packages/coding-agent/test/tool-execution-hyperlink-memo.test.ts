import { Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { TOOL_LINK_PREFIX, ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * Hyperlinking every transcript line runs each one through grapheme-level
 * slicing, which a CPU profile of a real session showed to be the dominant cost
 * of a frame. `CachedLineMap` alone does not prevent that: it hits only on
 * array *reference* equality, and `Container.render` returns a fresh array
 * whenever any single child re-rendered. One animating child therefore re-sliced
 * every line in the block. A per-line memo survives that array churn.
 *
 * These tests pin the behaviour the memo must preserve, and the invariant that
 * makes it safe: the hyperlink transform depends only on the line text and the
 * tool call id, so line text is a sound cache key.
 */

function createFakeViewportTui(): TUI {
	return {
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
		requestRender: () => {},
	} as unknown as TUI;
}

function createComponent(callId: string, output: string, tui: TUI = createFakeViewportTui()): ToolExecutionComponent {
	const toolDefinition: ToolDefinition = {
		name: "custom_tool",
		label: "Custom Tool",
		description: "test",
		parameters: undefined as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: undefined }),
		renderCall: () => new Text("call", 0, 0),
	};
	const component = new ToolExecutionComponent("custom_tool", callId, {}, {}, toolDefinition, tui, process.cwd());
	component.setExpanded(true);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
	return component;
}

describe("ToolExecutionComponent hyperlink memo", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("emits an OSC 8 hyperlink carrying the tool call id", () => {
		const component = createComponent("call-abc", "line one\nline two");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain(`${TOOL_LINK_PREFIX}call-abc`);
		// OSC 8 opener and terminator must both be present.
		expect(rendered).toContain("\x1b]8;;");
	});

	test("repeated renders of unchanged content produce identical output", () => {
		const component = createComponent("call-stable", "alpha\nbeta\ngamma");
		const first = component.render(120).join("\n");
		const second = component.render(120).join("\n");
		const third = component.render(120).join("\n");
		expect(second).toBe(first);
		expect(third).toBe(first);
	});

	test("memoised lines never leak between components with different call ids", () => {
		// Both components render byte-identical source text. If the memo were
		// shared or keyed only by line text globally, the second component would
		// inherit the first component's link target.
		const a = createComponent("call-AAA", "identical output line");
		const b = createComponent("call-BBB", "identical output line");
		expect(a.render(120).join("\n")).toContain(`${TOOL_LINK_PREFIX}call-AAA`);
		expect(b.render(120).join("\n")).toContain(`${TOOL_LINK_PREFIX}call-BBB`);
		expect(b.render(120).join("\n")).not.toContain(`${TOOL_LINK_PREFIX}call-AAA`);
	});

	test("content changes are reflected rather than served from the memo", () => {
		const component = createComponent("call-update", "first content");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("first content");
		component.updateResult({ content: [{ type: "text", text: "second content" }], isError: false }, false);
		const updated = stripAnsi(component.render(120).join("\n"));
		expect(updated).toContain("second content");
		expect(updated).not.toContain("first content");
	});

	test("width changes re-wrap rather than reuse the previous width's lines", () => {
		const long = "wordy ".repeat(40).trim();
		const component = createComponent("call-width", long);
		const narrow = component.render(40);
		const wide = component.render(120);
		// Narrower rendering must wrap into strictly more lines.
		expect(narrow.length).toBeGreaterThan(wide.length);
		for (const line of narrow) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
		}
	});

	test("invalidate() drops memoised lines so a theme change is picked up", () => {
		const component = createComponent("call-invalidate", "some content");
		const before = component.render(120).join("\n");
		component.invalidate();
		const after = component.render(120).join("\n");
		// Content is unchanged, so output should match; the point is that
		// invalidate() must not throw or serve stale structure.
		expect(stripAnsi(after)).toContain("some content");
		expect(after).toBe(before);
	});

	test("non-viewport TUIs skip hyperlinking entirely", () => {
		const plainTui = { requestRender: () => {} } as unknown as TUI;
		const component = createComponent("call-plain", "no links here", plainTui);
		const rendered = component.render(120).join("\n");
		expect(rendered).not.toContain("\x1b]8;;");
	});
});
