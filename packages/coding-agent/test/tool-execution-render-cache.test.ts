import { describe, expect, it } from "vitest";
import { CachedLineMap } from "../src/modes/interactive/components/render-cache.ts";

describe("CachedLineMap", () => {
	it("skips the transform when width and source are unchanged", () => {
		const cache = new CachedLineMap();
		const source = ["a", "b"];
		let calls = 0;
		const transform = (lines: string[]) => {
			calls++;
			return lines.map((l) => `<${l}>`);
		};

		const first = cache.map(80, source, transform);
		const second = cache.map(80, source, transform);
		expect(calls).toBe(1);
		expect(second).toBe(first);
		expect(first).toEqual(["<a>", "<b>"]);
	});

	it("re-runs when the source array identity changes", () => {
		const cache = new CachedLineMap();
		let calls = 0;
		const transform = (lines: string[]) => {
			calls++;
			return lines.slice();
		};
		cache.map(80, ["a"], transform);
		cache.map(80, ["a"], transform);
		expect(calls).toBe(2);
	});

	it("re-runs on width change and after clear()", () => {
		const cache = new CachedLineMap();
		const source = ["a"];
		let calls = 0;
		const transform = (lines: string[]) => {
			calls++;
			return lines.slice();
		};
		cache.map(80, source, transform);
		cache.map(100, source, transform);
		expect(calls).toBe(2);
		cache.map(100, source, transform);
		expect(calls).toBe(2);
		cache.clear();
		cache.map(100, source, transform);
		expect(calls).toBe(3);
	});

	it("never mutates the shared source array", () => {
		const cache = new CachedLineMap();
		const source = ["a", "b"];
		cache.map(80, source, (lines) => {
			const copy = lines.slice();
			copy[0] = "zoned";
			return copy;
		});
		expect(source).toEqual(["a", "b"]);
	});
});
