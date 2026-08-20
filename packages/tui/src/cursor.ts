/**
 * Shared fake-cursor rendering.
 *
 * Components (Editor, Input) draw a software cursor by styling the grapheme
 * under the caret. The style is pluggable so the host app can theme it:
 * `setCursorRenderer()` is called by the coding agent whenever the theme
 * changes, so the cursor picks up the theme's accent/cursor color instead of
 * being a plain reverse-video white block.
 *
 * Focus semantics when the host TUI can park the real cursor on the caret:
 * - focused   -> terminal-native blinking filled block
 * - unfocused -> terminal-native full-cell hollow block
 *
 * The software cursor is suppressed in both states. The terminal owns the
 * animation and the unfocused outline, so all four edges match the exact cell
 * size at no repaint cost. Where hardware positioning is unavailable, the
 * software fallback is a static reverse-video block when focused and an
 * overline + underline when not.
 */
export type CursorRenderer = (grapheme: string, focused: boolean) => string;

/** SGR 53/55 = overline on/off, 4/24 = underline on/off. */
export const CURSOR_OUTLINE_ON = "\x1b[53m\x1b[4m";
export const CURSOR_OUTLINE_OFF = "\x1b[24m\x1b[55m";

/** Reverse video (filled) when focused, outlined (unfilled) when not. */
const defaultCursorRenderer: CursorRenderer = (grapheme, focused) =>
	focused ? `\x1b[7m${grapheme}\x1b[27m` : `${CURSOR_OUTLINE_ON}${grapheme}${CURSOR_OUTLINE_OFF}`;

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
 * When the host TUI parks the real terminal cursor on the caret, the focused
 * cursor is left entirely to the terminal: it blinks natively and hollows out
 * by itself when the window loses focus. Otherwise a software cursor is drawn,
 * filled only when the component has app focus AND the terminal window/pane
 * itself is focused.
 */
export function renderCursor(grapheme: string, focused: boolean): string {
	const state = getCursorFrameState();
	state.current = true;
	if (focused && isHardwareHollowCursorEnabled()) {
		// The real cursor is parked here: the terminal blinks it while focused and
		// turns the same full-cell block hollow when the window loses focus.
		return grapheme;
	}
	return getCursorRenderer()(grapheme, focused && isTerminalFocused());
}

/**
 * Set by the TUI when it positions the hardware cursor on the caret, so the
 * terminal can blink its own cursor there instead of a static software block.
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
