import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Performance invariant, not just correctness.
 *
 * `CachedLineMap` only skips the hyperlink pass when the rendered line array is
 * reference-identical to the previous frame's. `Container.render` returns a
 * fresh array whenever *any* child re-rendered, so a single animating child
 * inside a tool block (a spinner, a streaming result) invalidated that cache and
 * pushed every line in the block back through grapheme-level slicing. On a real
 * transcript a CPU profile attributed ~75% of active CPU to that work.
 *
 * The per-line memo makes the expensive transform run once per distinct line
 * instead of once per frame. Cached and recomputed lines are byte-identical, and
 * JavaScript string primitives have no identity, so the reuse cannot be observed
 * by comparing values. It is observable as work: with the memo, repeated frames
 * over unchanged content are dramatically cheaper than the first frame.
 *
 * The assertion uses a deliberately loose ratio. The point is to catch a
 * regression that removes caching entirely (which makes every frame cost the
 * same as the first), not to pin a specific speed.
 */

function createFakeViewportTui(): TUI {
	return {
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
		requestRender: () => {},
	} as unknown as TUI;
}

/** A child that returns a new array with new content on every render. */
class AnimatingChild implements Component {
	private frame = 0;
	render(): string[] {
		this.frame++;
		return [`spinner ${this.frame}`];
	}
	invalidate(): void {}
}

function createLargeComponent(lineCount: number): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"custom_tool",
		"call-memo-reuse",
		{},
		{},
		undefined,
		createFakeViewportTui(),
		process.cwd(),
	);
	component.setExpanded(true);
	component.setArgsComplete();
	component.markExecutionStarted();
	// Distinct, non-trivial lines: styling and wide graphemes are what make the
	// hyperlink pass expensive, and distinct text prevents accidental sharing.
	const text = Array.from(
		{ length: lineCount },
		(_, i) => `stable-marker ${i} \u001b[38;5;244m|\u001b[0m result ✓ ${"detail ".repeat(6)}`,
	).join("\n");
	component.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return component;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("ToolExecutionComponent hyperlink memo reuse", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("re-rendering unchanged lines is far cheaper than the first pass", () => {
		const component = createLargeComponent(400);
		// Attach an animating child so the block's line array identity changes
		// every frame, defeating CachedLineMap on purpose. Only the per-line memo
		// can keep the hyperlink pass off the hot path here.
		(component as unknown as Container).addChild(new AnimatingChild());

		const first = timeRender(component);
		const repeats: number[] = [];
		for (let i = 0; i < 12; i++) repeats.push(timeRender(component));
		const steady = median(repeats);

		// Without the memo every frame repeats the full hyperlink pass, so steady
		// state matches the first frame. With it, steady state is a small fraction.
		expect(steady).toBeLessThan(first / 3);
	});

	test("the animating child really does change every frame", () => {
		const component = createLargeComponent(4);
		(component as unknown as Container).addChild(new AnimatingChild());
		const seen = new Set<string>();
		for (let i = 0; i < 6; i++) {
			const spinner = component.render(120).find((l) => l.includes("spinner"));
			if (spinner !== undefined) seen.add(spinner);
		}
		// If this collapses, the test above is not exercising the cache-miss path.
		expect(seen.size).toBe(6);
	});
});

function timeRender(component: ToolExecutionComponent): number {
	const start = performance.now();
	component.render(120);
	return performance.now() - start;
}
