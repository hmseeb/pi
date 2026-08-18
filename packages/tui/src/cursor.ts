/**
 * Shared fake-cursor rendering.
 *
 * Components (Editor, Input) draw a software cursor by styling the grapheme
 * under the caret. The style is pluggable so the host app can theme it:
 * `setCursorRenderer()` is called by the coding agent whenever the theme
 * changes, so the cursor picks up the theme's accent/cursor color instead of
 * being a plain reverse-video white block.
 *
 * Focus semantics:
 * - focused   -> filled block (theme colored), blinking like a native terminal
 *               cursor. Blink is the SGR 5 attribute, so the terminal owns the
 *               timing and no repaint timer is needed. Terminals that ignore
 *               SGR 5 simply show a steady block.
 * - unfocused -> hollow block. A text cell cannot draw left/right borders, so
 *                when the host TUI can park the real terminal cursor on the
 *                caret (main screen, via CURSOR_MARKER) the fake cursor is
 *                suppressed and the terminal draws its own native hollow box -
 *                all four edges. Where that is unavailable (alt screen, hosts
 *                that do not position the hardware cursor) it falls back to an
 *                overline + underline outline.
 */
export type CursorRenderer = (grapheme: string, focused: boolean) => string;

/** SGR 53/55 = overline on/off, 4/24 = underline on/off. */
export const CURSOR_OUTLINE_ON = "\x1b[53m\x1b[4m";
export const CURSOR_OUTLINE_OFF = "\x1b[24m\x1b[55m";

/** SGR 5/25 = blink on/off. Only the focused (filled) cursor blinks. */
export const CURSOR_BLINK_ON = "\x1b[5m";
export const CURSOR_BLINK_OFF = "\x1b[25m";

/** Blinking reverse video (filled) when focused, static outline when not. */
const defaultCursorRenderer: CursorRenderer = (grapheme, focused) =>
	focused
		? `${CURSOR_BLINK_ON}\x1b[7m${grapheme}\x1b[27m${CURSOR_BLINK_OFF}`
		: `${CURSOR_OUTLINE_ON}${grapheme}${CURSOR_OUTLINE_OFF}`;

// Shared across module loaders (tsx + jiti in dev mode), same trick as the theme.
const CURSOR_RENDERER_KEY = Symbol.for("@earendil-works/pi-tui:cursor-renderer");
const TERMINAL_FOCUS_KEY = Symbol.for("@earendil-works/pi-tui:terminal-focused");
const CURSOR_DRAWN_KEY = Symbol.for("@earendil-works/pi-tui:cursor-drawn");
const HARDWARE_HOLLOW_KEY = Symbol.for("@earendil-works/pi-tui:hardware-hollow-cursor");

export function setCursorRenderer(renderer: CursorRenderer | undefined): void {
	(globalThis as Record<symbol, CursorRenderer | undefined>)[CURSOR_RENDERER_KEY] = renderer;
}

export function getCursorRenderer(): CursorRenderer {
	return (globalThis as Record<symbol, CursorRenderer | undefined>)[CURSOR_RENDERER_KEY] ?? defaultCursorRenderer;
}

/**
 * Terminal window/pane focus, reported by the terminal via DECSET 1004
 * (`ESC [ I` / `ESC [ O`). Tracked globally because Editor/Input have no
 * reference to the TUI instance. Defaults to focused so terminals without
 * focus reporting keep a filled cursor.
 */
export function setTerminalFocused(focused: boolean): void {
	(globalThis as Record<symbol, boolean | undefined>)[TERMINAL_FOCUS_KEY] = focused;
}

export function isTerminalFocused(): boolean {
	return (globalThis as Record<symbol, boolean | undefined>)[TERMINAL_FOCUS_KEY] ?? true;
}

/**
 * Render the grapheme under the caret with the active cursor style.
 *
 * The cursor is only filled when the component has app focus AND the terminal
 * window/pane itself is focused - an unfocused split should hollow out just
 * like a native terminal cursor does.
 */
export function renderCursor(grapheme: string, focused: boolean): string {
	const state = getCursorFrameState();
	state.current = true;
	if (focused && !isTerminalFocused() && isHardwareHollowCursorEnabled()) {
		// The real terminal cursor is parked here and draws the hollow box itself.
		return grapheme;
	}
	return getCursorRenderer()(grapheme, focused && isTerminalFocused());
}

/**
 * Set by the TUI when it positions the hardware cursor on the caret, so an
 * unfocused terminal can show its own native hollow cursor instead of a
 * software outline.
 */
export function setHardwareHollowCursor(enabled: boolean): void {
	(globalThis as Record<symbol, boolean | undefined>)[HARDWARE_HOLLOW_KEY] = enabled;
}

export function isHardwareHollowCursorEnabled(): boolean {
	return (globalThis as Record<symbol, boolean | undefined>)[HARDWARE_HOLLOW_KEY] === true;
}

type CursorFrameState = { current: boolean; previous: boolean };

function getCursorFrameState(): CursorFrameState {
	const store = globalThis as Record<symbol, CursorFrameState | undefined>;
	const existing = store[CURSOR_DRAWN_KEY];
	if (existing) return existing;
	const created: CursorFrameState = { current: false, previous: false };
	store[CURSOR_DRAWN_KEY] = created;
	return created;
}

/** Called by the TUI before each render pass so cursor tracking is per-frame. */
export function beginCursorFrame(): void {
	const state = getCursorFrameState();
	state.previous = state.current;
	state.current = false;
}

/**
 * True when the last (or in-progress) render drew a fake cursor. Lets the TUI
 * skip repaints on terminal focus changes when nothing on screen depends on it.
 */
export function hasRenderedCursor(): boolean {
	const state = getCursorFrameState();
	return state.current || state.previous;
}
