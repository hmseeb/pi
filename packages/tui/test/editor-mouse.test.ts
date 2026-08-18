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

function press(editor: Editor, x: number, y: number, width = 40): boolean {
	return editor.handleMouse({ x, y, width, button: 0, action: "press" });
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
	const consumed = press(editor, x, y, width);
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

		assert.strictEqual(editor.handleMouse({ x: 3, y: 1, width: 40, button: 2, action: "press" }), false);
		assert.strictEqual(editor.handleMouse({ x: 3, y: 1, width: 40, button: 0, action: "drag" }), false);
		assert.strictEqual(editor.handleMouse({ x: 3, y: 1, width: 40, button: 0, action: "release" }), false);
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
		press(editor, markerStart + 3, 1, 60);
		const cursor = findCursor(editor.render(60));

		// The caret must sit at the marker start (or before it), never inside.
		assert.ok(
			cursor.col <= markerStart,
			`caret at ${cursor.col} should not be inside the marker starting at ${markerStart}`,
		);
	});
});

/**
 * Editor subclass that decorates its own output, mirroring the shipped
 * `slash-command-colors` extension: render at a reduced width, then prepend a
 * prompt icon to the first text row and matching blanks to the rest.
 */
class PromptIconEditor extends Editor {
	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines = super.render(innerWidth);
		let firstContentLine = true;
		return lines.map((line, index) => {
			const isBorder = index === 0 || index === lines.length - 1;
			if (isBorder) return line + "\u2500".repeat(2);
			const prefix = firstContentLine ? "\u276f " : "  ";
			firstContentLine = false;
			return prefix + line;
		});
	}
}

describe("editor click with a decorated horizontal origin", () => {
	// Regression: a decorating subclass shifts its content right, but the click
	// arrived in box coordinates that still included the prefix, so the caret
	// landed exactly prefixWidth columns too far right. Verified live against the
	// real TUI: clicking screen column 2 (the first character) produced offset 2.
	it("places the caret on the clicked character despite a prompt prefix", () => {
		const boxWidth = 40;
		const editor = new PromptIconEditor(createTestTUI(boxWidth), defaultEditorTheme);
		editor.focused = true;
		editor.setText("abcdefghijklmnop");

		const rendered = editor.render(boxWidth);
		const prefixWidth = 2;
		assert.ok(rendered[1]!.startsWith("\u276f "), "decorated row should start with the prompt icon");

		// Clicking the Nth text character means clicking box column prefixWidth + N.
		for (const target of [0, 5, 10, 16]) {
			editor.render(boxWidth);
			assert.strictEqual(press(editor, prefixWidth + target, 1, boxWidth), true);
			const cursor = findCursor(editor.render(boxWidth));
			assert.strictEqual(
				cursor.col,
				prefixWidth + target,
				`click on text column ${target} should put the caret there, not ${cursor.col - prefixWidth}`,
			);
		}
	});

	it("keeps an undecorated editor unaffected", () => {
		// The origin shift is derived from the width difference, so an editor that
		// renders at the full box width must resolve to a zero shift.
		const editor = new Editor(createTestTUI(40), defaultEditorTheme);
		editor.focused = true;
		editor.setText("hello world");

		const result = clickAt(editor, 40, 4, 1);
		assert.strictEqual(result.col, 4);
	});

	it("resolves wide graphemes relative to the shifted origin", () => {
		const boxWidth = 40;
		const prefixWidth = 2;
		const editor = new PromptIconEditor(createTestTUI(boxWidth), defaultEditorTheme);
		editor.focused = true;
		editor.setText("ab\u2705cd");

		// Emoji occupies text columns 2-3, i.e. box columns 4-5.
		editor.render(boxWidth);
		press(editor, prefixWidth + 2, 1, boxWidth);
		assert.strictEqual(findCursor(editor.render(boxWidth)).col, prefixWidth + 2, "left half snaps to emoji start");

		editor.render(boxWidth);
		press(editor, prefixWidth + 3, 1, boxWidth);
		assert.strictEqual(findCursor(editor.render(boxWidth)).col, prefixWidth + 4, "right half snaps past the emoji");
	});

	it("positions the caret on a wrapped continuation row under a prefix", () => {
		const boxWidth = 14;
		const prefixWidth = 2;
		const editor = new PromptIconEditor(createTestTUI(boxWidth), defaultEditorTheme);
		editor.focused = true;
		editor.setText("aaaa bbbb cccc dddd");

		const lines = editor.render(boxWidth);
		assert.ok(lines.length - 2 >= 2, "text should occupy at least two visual rows");

		editor.render(boxWidth);
		assert.strictEqual(press(editor, prefixWidth + 1, 2, boxWidth), true);
		const cursor = findCursor(editor.render(boxWidth));
		assert.strictEqual(cursor.row, 2, "caret should stay on the clicked visual row");
		assert.strictEqual(cursor.col, prefixWidth + 1);
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
			width: target.rect.width,
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
				target.component.handleMouse?.({
					x: 5 - target.rect.x,
					y: 2 - target.rect.y,
					width: target.rect.width,
					button: 0,
					action: "press",
				})
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
