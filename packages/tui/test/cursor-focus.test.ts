import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import {
	beginCursorFrame,
	hasRenderedCursor,
	isTerminalFocused,
	setHardwareHollowCursor,
	setTerminalFocused,
} from "../src/cursor.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FILLED = "\x1b[7m";
const OUTLINE = "\x1b[53m\x1b[4m";
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const BLINKING_BLOCK = "\x1b[1 q";
const DEFAULT_CURSOR = "\x1b[0 q";

function renderInput(): string {
	const input = new Input();
	input.focused = true;
	input.handleInput("a");
	return input.render(20).join("");
}

describe("terminal focus cursor", () => {
	afterEach(() => {
		setTerminalFocused(true);
		setHardwareHollowCursor(false);
	});

	it("defaults to focused", () => {
		assert.strictEqual(isTerminalFocused(), true);
	});

	it("draws a filled cursor while the terminal is focused", () => {
		setTerminalFocused(true);
		assert.ok(renderInput().includes(FILLED));
	});

	it("outlines the cursor when the terminal is unfocused and software owns it", () => {
		setHardwareHollowCursor(false);
		setTerminalFocused(false);
		const output = renderInput();
		assert.ok(output.includes(OUTLINE), "software fallback should use overline + underline");
		assert.ok(!output.includes(FILLED), "cursor should not have a background");
	});

	it("drops the fake cursor when the terminal draws its native hollow block", () => {
		setHardwareHollowCursor(true);
		setTerminalFocused(false);
		const output = renderInput();
		assert.ok(!output.includes(OUTLINE), "terminal owns all four outline edges");
		assert.ok(!output.includes(FILLED), "cursor should not have a software background");
	});

	it("drops the fake cursor when the terminal blinks its own", () => {
		setHardwareHollowCursor(true);
		setTerminalFocused(true);
		const output = renderInput();
		assert.ok(!output.includes(FILLED), "filled block should yield to the blinking hardware cursor");
		assert.ok(!output.includes(OUTLINE), "no software outline either");
	});

	it("reports whether the last frame drew a cursor", () => {
		beginCursorFrame();
		beginCursorFrame();
		assert.strictEqual(hasRenderedCursor(), false);
		renderInput();
		assert.strictEqual(hasRenderedCursor(), true);
		beginCursorFrame();
		assert.strictEqual(hasRenderedCursor(), true, "previous frame still counts");
		beginCursorFrame();
		assert.strictEqual(hasRenderedCursor(), false);
	});
});

class CursorRecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override showCursor(): void {
		this.writes.push(SHOW_CURSOR);
		super.showCursor();
	}

	override hideCursor(): void {
		this.writes.push(HIDE_CURSOR);
		super.hideCursor();
	}
}

describe("main screen hardware cursor handoff", () => {
	afterEach(() => {
		setTerminalFocused(true);
		setHardwareHollowCursor(false);
	});

	it("shows the real cursor and stops painting a block on focus loss", async () => {
		const terminal = new CursorRecordingTerminal(40, 6);
		const tui = new TuiMainScreen(terminal);
		const input = new Input();
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		input.handleInput("a");
		tui.renderNow(true);

		const focusedFrame = terminal.writes.join("");
		assert.ok(!focusedFrame.includes(FILLED), "focused frame paints no fake block");
		assert.ok(focusedFrame.includes(SHOW_CURSOR), "real cursor shown so the terminal blinks it");
		assert.ok(focusedFrame.includes(BLINKING_BLOCK), "stale pane cursor style replaced with blinking block");
		assert.ok(
			terminal.writes.some((w) => w.includes("\x1b[?1004h")),
			"focus reporting enabled",
		);

		terminal.writes.length = 0;
		terminal.sendInput("\x1b[O");
		await new Promise((resolve) => setTimeout(resolve, 50));
		tui.renderNow(true);

		const unfocusedFrame = terminal.writes.join("");
		assert.strictEqual(isTerminalFocused(), false, "focus-out tracked");
		assert.ok(!unfocusedFrame.includes(FILLED), "no software background while unfocused");
		assert.ok(!unfocusedFrame.includes(OUTLINE), "terminal owns all four outline edges");
		assert.ok(unfocusedFrame.includes(SHOW_CURSOR), "real cursor remains visible for native block_hollow");
		assert.ok(!unfocusedFrame.includes(DEFAULT_CURSOR), "block style stays active through focus loss");

		tui.stop();
		assert.ok(terminal.writes.join("").includes(DEFAULT_CURSOR), "terminal cursor style restored on exit");
	});
});

describe("alt screen (fullscreen mode) hardware cursor handoff", () => {
	afterEach(() => {
		setTerminalFocused(true);
		setHardwareHollowCursor(false);
	});

	it("shows the real cursor and stops painting a block on focus loss", async () => {
		const terminal = new CursorRecordingTerminal(40, 6);
		const tui = new TuiAltScreen(terminal);
		const input = new Input();
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		input.handleInput("a");
		tui.renderNow(true);
		const focusedFrame = terminal.writes.join("");
		assert.ok(!focusedFrame.includes(FILLED), "focused frame paints no fake block");
		assert.ok(focusedFrame.includes(SHOW_CURSOR), "real cursor shown so the terminal blinks it");
		assert.ok(focusedFrame.includes(BLINKING_BLOCK), "stale pane cursor style replaced with blinking block");

		terminal.writes.length = 0;
		terminal.sendInput("\x1b[O");
		await new Promise((resolve) => setTimeout(resolve, 50));
		tui.renderNow(true);

		const frame = terminal.writes.join("");
		assert.strictEqual(isTerminalFocused(), false, "focus-out tracked");
		assert.ok(!frame.includes(FILLED), "no software background while unfocused");
		assert.ok(!frame.includes(OUTLINE), "terminal owns all four outline edges");
		assert.ok(frame.includes(SHOW_CURSOR), "real cursor remains visible for native block_hollow");
		assert.ok(!frame.includes(DEFAULT_CURSOR), "block style stays active through focus loss");

		tui.stop();
		assert.ok(terminal.writes.join("").includes(DEFAULT_CURSOR), "terminal cursor style restored on exit");
	});
});
