import assert from "node:assert";
import { describe, it } from "node:test";
import { sliceByColumn, sliceWithWidth, visibleWidth } from "../src/utils.ts";

/**
 * sliceWithWidth locates the end of each plain-text run with a single
 * indexOf("\x1b") and skips grapheme segmentation entirely for printable-ASCII
 * runs. Both are load-bearing for transcript render cost, and both are easy to
 * break in ways that only show up on unusual input: a wrong run end silently
 * drops or duplicates styling, and the ASCII fast path must never be taken for
 * text whose display width differs from its code-unit count.
 *
 * These tests pin the observable contract rather than the implementation, so the
 * scan can be optimised further without rewriting them.
 */
describe("sliceWithWidth ANSI run scanning", () => {
	it("slicing the full visible width preserves visible width", () => {
		const cases = [
			"hello world",
			"\x1b[31mred\x1b[0m text",
			"ab中文cd",
			"ab🎉cd",
			"x👨‍👩‍👦y",
			"éabc",
			"text   ",
			"\x1b[32m中文\x1b[0m ok",
		];
		for (const line of cases) {
			const width = visibleWidth(line);
			assert.strictEqual(
				visibleWidth(sliceByColumn(line, 0, width, true)),
				width,
				`round trip failed for ${JSON.stringify(line)}`,
			);
		}
	});

	it("never splits a wide grapheme across the slice boundary", () => {
		const line = "ab🎉cd";
		for (let col = 0; col <= visibleWidth(line); col++) {
			const left = sliceByColumn(line, 0, col, true);
			const hasLoneSurrogate = left.includes("\ud83c") && !left.includes("🎉");
			assert.ok(!hasLoneSurrogate, `column ${col} split the emoji: ${JSON.stringify(left)}`);
		}
	});

	it("keeps ANSI codes that open before the slice and apply inside it", () => {
		// The colour opens at column 0 but the slice starts at column 2; the code
		// must still be emitted so the visible text stays styled.
		const line = "\x1b[31mabcdef\x1b[0m";
		const slice = sliceByColumn(line, 2, 2, true);
		assert.ok(slice.includes("\x1b[31m"), `pending style dropped: ${JSON.stringify(slice)}`);
		assert.strictEqual(visibleWidth(slice), 2);
	});

	it("handles a run that ends exactly at an escape sequence", () => {
		// Regression guard for the indexOf-based run scan: the plain-text run must
		// stop at the ESC, not consume it or overshoot past it.
		const line = "ab\x1b[31mcd\x1b[0mef";
		assert.strictEqual(visibleWidth(line), 6);
		assert.strictEqual(visibleWidth(sliceByColumn(line, 0, 6, true)), 6);
		assert.strictEqual(visibleWidth(sliceByColumn(line, 2, 2, true)), 2);
	});

	it("reports width consistent with the returned text", () => {
		for (const line of ["plain ascii", "\x1b[1mbold\x1b[0m", "中文abc", "🎉🎉"]) {
			for (let start = 0; start <= 3; start++) {
				const { text, width } = sliceWithWidth(line, start, 3, true);
				assert.strictEqual(width, visibleWidth(text), `width mismatch for ${JSON.stringify(line)} at ${start}`);
			}
		}
	});

	it("treats non-ASCII runs as wide even when they are single code units", () => {
		// The ASCII fast path assumes one column per character. Characters just
		// outside printable ASCII must not take it.
		const line = "\u00e9\u00e9\u00e9";
		assert.strictEqual(visibleWidth(sliceByColumn(line, 0, 3, true)), 3);
	});

	it("returns empty for non-positive lengths", () => {
		assert.deepStrictEqual(sliceWithWidth("abc", 0, 0, true), { text: "", width: 0 });
		assert.deepStrictEqual(sliceWithWidth("abc", 0, -1, true), { text: "", width: 0 });
	});
});
