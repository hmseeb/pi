import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { type Component, Container } from "../src/tui.ts";

/** Counts how often it re-renders, and returns a stable array while unchanged. */
class CountingComponent implements Component {
	renders = 0;
	private text: string;
	private cache?: { width: number; lines: string[] };

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		this.renders++;
		const lines = [`${this.text}@${width}`];
		this.cache = { width, lines };
		return lines;
	}
}

describe("Container render cache", () => {
	it("reuses the concatenated array when no child re-rendered", () => {
		const container = new Container();
		container.addChild(new CountingComponent("a"));
		container.addChild(new CountingComponent("b"));

		const first = container.render(20);
		const second = container.render(20);
		assert.strictEqual(second, first, "same array reference on a repeat frame");
		assert.deepStrictEqual(first, ["a@20", "b@20"]);
	});

	it("rebuilds when a child changes", () => {
		const child = new CountingComponent("a");
		const container = new Container();
		container.addChild(child);

		const first = container.render(20);
		child.setText("z");
		const second = container.render(20);
		assert.notStrictEqual(second, first, "changed child invalidates the cached array");
		assert.deepStrictEqual(second, ["z@20"]);
	});

	it("rebuilds on width change", () => {
		const container = new Container();
		container.addChild(new CountingComponent("a"));
		const first = container.render(20);
		const second = container.render(30);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(second, ["a@30"]);
	});

	it("rebuilds when children are added, removed, or cleared", () => {
		const container = new Container();
		const a = new CountingComponent("a");
		container.addChild(a);
		const first = container.render(20);

		const b = new CountingComponent("b");
		container.addChild(b);
		const afterAdd = container.render(20);
		assert.deepStrictEqual(afterAdd, ["a@20", "b@20"]);

		container.removeChild(b);
		const afterRemove = container.render(20);
		assert.deepStrictEqual(afterRemove, ["a@20"]);
		assert.notStrictEqual(afterRemove, first, "cache is not reused across membership changes");

		container.clear();
		assert.deepStrictEqual(container.render(20), []);
	});

	it("does not re-render unchanged children more than once per width", () => {
		const child = new CountingComponent("a");
		const container = new Container();
		container.addChild(child);
		for (let i = 0; i < 10; i++) container.render(20);
		assert.strictEqual(child.renders, 1, "child output is rendered once and reused");
	});

	it("invalidate() drops the cache and the children's caches", () => {
		const child = new CountingComponent("a");
		const container = new Container();
		container.addChild(child);
		const first = container.render(20);
		container.invalidate();
		const second = container.render(20);
		assert.notStrictEqual(second, first);
		assert.strictEqual(child.renders, 2);
	});

	it("nests: an outer container reuses when the inner one is unchanged", () => {
		const inner = new Container();
		inner.addChild(new Text("hello", 0, 0));
		const outer = new Container();
		outer.addChild(inner);

		const first = outer.render(20);
		assert.strictEqual(outer.render(20), first);
		inner.addChild(new Text("world", 0, 0));
		assert.notStrictEqual(outer.render(20), first);
	});
});
