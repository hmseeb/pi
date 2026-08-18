import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getMouseTargetsAt, renderLayoutFrame } from "../src/layout.ts";
import { Container, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

function press(editor: Editor, x: number, y: number): boolean {
	return editor.handleMouse({ x, y, button: 0, action: "press" });
}

/**
 * Locate the caret in rendered output by finding the reverse-video marker the
 * editor emits at the cursor. Returns the row (index into `lines`) and the
 * display column at which the highlight starts.
 */
function findCursor(lines: string[]): { row: number; col: number } {
	for (let row = 0; row < lines.length; row++) {
		const index = lines[row]!.indexOf("\x1b[7m");
		if (index === -1) continue;
		return { row, col: visibleWidth(lines[row]!.slice(0, index)) };
	}
	throw new Error("no cursor marker found in rendered output");
}

/** Render, click, re-render, and report where the caret ended up. */
function clickAt(editor: Editor, width: number, x: number, y: number): { row: number; col: number; consumed: boolean } {
	editor.render(width);
	const consumed = press(editor, x, y);
	return { ...findCursor(editor.render(width)), consumed };
}

describe("editor mouse click-to-position", () => {
	it("moves the caret to the clicked column on a single line", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");

		// Row 0 is the top border, so the first text row is y=1.
		const result = clickAt(editor, 40, 3, 1);
		assert.strictEqual(result.consumed, true);
		assert.strictEqual(result.row, 1);
		assert.strictEqual(result.col, 3);
	});

	it("clamps to end of line when clicking past the text", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("abc");

		const result = clickAt(editor, 40, 30, 1);
		assert.strictEqual(result.consumed, true);
		assert.strictEqual(result.col, 3, "caret should sit just past the final character");
	});

	it("positions the caret on a wrapped continuation line", () => {
		const width = 12;
		const editor = new Editor(createTestTUI(width), defaultEditorTheme);
		editor.focused = true;
		// Wraps across multiple visual rows at this width.
		editor.setText("aaaa bbbb cccc dddd");

		const lines = editor.render(width);
		const contentRows = lines.length - 2;
		assert.ok(contentRows >= 2, "text should occupy at least two visual rows");

		// Click on the second visual row (y=2), column 1.
		const result = clickAt(editor, width, 1, 2);
		assert.strictEqual(result.consumed, true);
		assert.strictEqual(result.row, 2, "caret should stay on the clicked visual row");
		assert.strictEqual(result.col, 1);
	});

	it("lands on a grapheme boundary when clicking a wide character", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		// The emoji occupies two display columns (2 and 3).
		editor.setText("ab✅cd");

		// Left half of the emoji snaps to its start.
		const before = clickAt(editor, 40, 2, 1);
		assert.strictEqual(before.col, 2, "click on left half snaps to emoji start");

		// Right half snaps past the whole cluster, never inside it.
		const after = clickAt(editor, 40, 3, 1);
		assert.strictEqual(after.col, 4, "click on right half snaps past the emoji");
	});

	it("accounts for scrollOffset when the editor has scrolled", () => {
		const tui = createTestTUI(40, 24);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.focused = true;

		// More lines than the visible window (max(5, 30% of 24 rows) = 7).
		const total = 20;
		editor.setText(Array.from({ length: total }, (_, i) => `line${i}`).join("\n"));

		// Cursor starts on the last line, so the view is scrolled to the bottom.
		const lines = editor.render(40);
		const visibleCount = lines.length - 2;
		assert.ok(visibleCount < total, "view must be scrolled for this test to be meaningful");

		// Click the first visible text row; it is not logical line 0.
		editor.render(40);
		assert.strictEqual(press(editor, 0, 1), true);
		const after = editor.render(40);
		const cursor = findCursor(after);
		assert.strictEqual(cursor.row, 1, "caret should be on the clicked row");
		assert.strictEqual(cursor.col, 0);

		// The caret must be on the logical line actually displayed there, which
		// is offset by the scroll position rather than line 0.
		const clickedText = after[1]!;
		const expectedLine = total - visibleCount;
		assert.ok(
			clickedText.includes(`ine${expectedLine}`) || clickedText.includes(`line${expectedLine}`),
			`expected first visible row to show line${expectedLine}, got: ${JSON.stringify(clickedText)}`,
		);
	});

	it("accounts for horizontal padding", () => {
		const paddingX = 2;
		const width = 40;
		const editor = new Editor(createTestTUI(width), defaultEditorTheme, { paddingX });
		editor.focused = true;
		editor.setText("hello world");

		// x includes the left padding, so x = paddingX + 4 targets column 4.
		const result = clickAt(editor, width, paddingX + 4, 1);
		assert.strictEqual(result.consumed, true);
		assert.strictEqual(result.col, paddingX + 4);
	});

	it("ignores clicks on the borders and outside the text rows", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello");
		const lines = editor.render(40);

		// Top border.
		assert.strictEqual(press(editor, 2, 0), false);
		// Bottom border sits immediately after the single text row.
		assert.strictEqual(press(editor, 2, lines.length - 1), false);
		// Well below the component.
		assert.strictEqual(press(editor, 2, lines.length + 5), false);
	});

	it("ignores non-left buttons, drags and releases", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");
		editor.render(40);

		assert.strictEqual(editor.handleMouse({ x: 3, y: 1, button: 2, action: "press" }), false);
		assert.strictEqual(editor.handleMouse({ x: 3, y: 1, button: 0, action: "drag" }), false);
		assert.strictEqual(editor.handleMouse({ x: 3, y: 1, button: 0, action: "release" }), false);
	});

	it("keeps the caret out of the interior of a collapsed paste marker", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.focused = true;
		// Bracketed paste of a large block collapses into a single marker.
		const big = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
		editor.handleInput(`\x1b[200~${big}\x1b[201~`);

		const text = editor.getText();
		const markerStart = text.indexOf("[");
		assert.ok(markerStart >= 0, `expected a collapsed marker, got: ${JSON.stringify(text)}`);

		editor.render(60);
		// Click a few columns into the marker body.
		press(editor, markerStart + 3, 1);
		const cursor = findCursor(editor.render(60));

		// The caret must sit at the marker start (or before it), never inside.
		assert.ok(
			cursor.col <= markerStart,
			`caret at ${cursor.col} should not be inside the marker starting at ${markerStart}`,
		);
	});
});

describe("layout mouse routing", () => {
	it("hit-tests the editor through the layout tree and offsets coordinates", () => {
		const tui = createTestTUI(40, 24);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");

		// A header pushes the editor down, so its rect.y is non-zero and screen
		// coordinates must be translated before reaching the component.
		const root = new VStack([{ component: new Text("header", 0, 0) }, { component: editor }]);
		const frame = renderLayoutFrame(root, 40, 24, () => {});

		const target = getMouseTargetsAt(frame, 5, 2)[0];
		assert.ok(target, "expected to hit a mouse-handling component");
		assert.strictEqual(target.component, editor);
		assert.strictEqual(target.rect.y, 1, "editor sits below the 1-line header");

		// Screen y=2 maps to box-local y=1, the first text row.
		const consumed = target.component.handleMouse?.({
			x: 5 - target.rect.x,
			y: 2 - target.rect.y,
			button: 0,
			action: "press",
		});
		assert.strictEqual(consumed, true);
		assert.strictEqual(findCursor(editor.render(40)).col, 5);
	});

	it("routes through a Container to the editor nested inside it", () => {
		// Containers flatten children into one block of lines, so the editor gets no
		// layout box of its own; the Container must rebase and forward the event.
		const tui = createTestTUI(40, 24);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");

		const container = new Container();
		container.addChild(new Text("header", 0, 0));
		container.addChild(editor);

		const frame = renderLayoutFrame(container, 40, 24, () => {});
		const targets = getMouseTargetsAt(frame, 5, 2);
		assert.ok(targets.length > 0, "expected the container to be a mouse target");

		let consumed = false;
		for (const target of targets) {
			if (
				target.component.handleMouse?.({ x: 5 - target.rect.x, y: 2 - target.rect.y, button: 0, action: "press" })
			) {
				consumed = true;
				break;
			}
		}
		assert.strictEqual(consumed, true, "click should reach the nested editor");
		assert.strictEqual(findCursor(editor.render(40)).col, 5);
	});

	it("never targets a component that does not implement handleMouse", () => {
		const text = new Text("plain", 0, 0);
		const frame = renderLayoutFrame(new VStack([{ component: text }]), 40, 24, () => {});
		const targets = getMouseTargetsAt(frame, 2, 0);
		assert.ok(
			!targets.some((target) => target.component === text),
			"a component without handleMouse must never be offered the event",
		);
	});
});
