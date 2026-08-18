# Follow-up: click-to-position-cursor in regular (main-screen) TUI mode

## Status

Click-to-position-cursor shipped on branch `feat/editor-click-to-position-cursor`, but it
only works in **fullscreen mode** (`pi --tui-mode fullscreen`, or `tuiMode: "fullscreen"`
in settings). In the default **regular** mode, clicking in the editor still does nothing.

This document records the gap and what a fix would involve. It is deliberately not
implemented, because enabling mouse capture in regular mode has a user-visible cost that
needs a product decision first.

## Why it does not work in regular mode

pi has two renderers:

| Mode | Class | File | Mouse support |
| --- | --- | --- | --- |
| `fullscreen` | `TuiAltScreen` | `packages/tui/src/tui-alt-screen.ts` | yes |
| `regular` (default) | `TuiMainScreen` | `packages/tui/src/tui-main-screen.ts` | none |

The renderer is chosen in `createInteractiveTui()`
(`packages/coding-agent/src/modes/interactive/interactive-mode.ts:351`):

```ts
if (options.tuiMode === "fullscreen") {
    return new TuiAltScreen(terminal, ..., altScreenOptions);
}
return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
```

`TuiMainScreen` contains no mouse code at all. It never writes the DECSET sequences that
ask the terminal to report clicks, so no mouse events are ever produced. Nothing downstream
can fix this: the events do not exist.

Confirmed empirically. With the branch checked out and mouse debug logging added to
`handleViewportInput`, clicking in regular mode produced no events, while the identical
click in fullscreen mode produced:

```
EVT {"button":0,"x":8,"y":25,"release":false}
```

## What a fix requires

### 1. Enable and disable mouse reporting

`TuiAltScreen` writes these on start (`tui-alt-screen.ts:58-60`):

```ts
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE    = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE              = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
```

Meaning: `1000` = button press/release, `1002` = button-motion (drag) tracking,
`1003` = any-motion tracking, `1004` = focus in/out, `1006` = SGR extended coordinates
(required above column 223).

`TuiAltScreen` picks the button-motion variant under a multiplexer (`TMUX`, `ZELLIJ`, `STY`,
or `TERM` starting `tmux`/`screen`) because forwarding every pointer move is slow there.
Regular mode should reuse that same heuristic.

`DISABLE_MOUSE` must be written on stop, and on any path that suspends the TUI
(ctrl+z, shelling out to `$EDITOR`, crash handlers). Leaking mouse mode into the user's
shell leaves the terminal emitting escape garbage on every click, which is a bad failure.

`TuiMainScreen` already has the hook to attach to: `beforeTerminalStop()` at
`tui-main-screen.ts:104`. It needs a matching start-side hook.

### 2. Route events to the component hook

The routing layer is already written and renderer-agnostic. `TuiAltScreen.handleViewportInput`
does:

```ts
const mouseEvent = this.parseSgrMouseEvent(data);
if (mouseEvent) {
    if (this.handleRightClickPaste(mouseEvent)) return { consume: true };
    const handled = this.handleScrollbarMouseEvent(mouseEvent);
    if (!this.scrollbarDrag) this.updateScrollbarHover(mouseEvent.x, mouseEvent.y);
    if (!handled && this.handleComponentMouseEvent(mouseEvent)) return { consume: true };
    if (!handled) this.handleSelectionMouseEvent(mouseEvent);
    return { consume: true };
}
```

Regular mode only needs the `parseSgrMouseEvent` + `handleComponentMouseEvent` pair; it has
no scrollbar, no app-owned selection, and no search overlay. `handleComponentMouseEvent`,
`getMouseTargetsAt()` (`layout.ts`), `Component.handleMouse` and `Editor.handleMouse` are
all already in place and need no changes.

One real complication: regular mode renders **inline in the scrollback**, not into a
fixed-size alt screen. Mouse coordinates arrive as absolute terminal rows, so they must be
translated into layout rows using the current render origin. Alt-screen mode gets this free
because its viewport always starts at row 0. Getting this wrong means clicks land on the
wrong line after the transcript scrolls, which is worse than no feature.

### 3. The tradeoff: native text selection is lost

This is the reason this is not just a small patch.

While mouse reporting is on, the terminal forwards clicks and drags to the application
instead of performing its own selection. In alt-screen mode this costs nothing, because
pi implements its own selection and clipboard copy (`handleSelectionMouseEvent`,
`copySelectionToClipboard`).

Regular mode has no such implementation. Turning mouse reporting on there would take away
the user's normal click-drag-to-select-and-copy over their terminal scrollback, and give
back nothing. For a mode whose whole point is that output stays in the scrollback, that is
a significant regression.

Workaround, if enabled: most terminals bypass application mouse capture when a modifier is
held while dragging.

| Terminal | Bypass modifier |
| --- | --- |
| iTerm2 | Option |
| macOS Terminal.app | Option (Fn on some configs) |
| GNOME Terminal / VTE | Shift |
| Kitty | Shift |
| Alacritty | Shift |
| WezTerm | Shift |
| tmux (with `mouse on`) | Shift |

This is discoverable only if documented, and it is muscle memory for many users. That is
why the recommendation below is opt-in rather than default-on.

## Suggested opt-in setting (sketch only, not implemented)

Add alongside the existing TUI settings in `packages/coding-agent/src/core/settings-manager.ts`,
next to `tuiMode`, `fullscreenExitOutput` and `fullscreenScrollbar`:

```ts
/** Capture mouse in regular TUI mode so clicking the editor moves the caret.
 *  Costs native click-drag text selection; hold Option/Shift to bypass.
 *  Default: false. No effect in fullscreen mode, where mouse is always on. */
regularModeMouse?: boolean;   // default: false
```

Accessors mirroring the existing pattern (`getTuiMode`/`setTuiMode` at
`settings-manager.ts:1131-1139`):

```ts
getRegularModeMouse(): boolean {
    return this.settings.regularModeMouse === true;
}

setRegularModeMouse(enabled: boolean): void {
    this.globalSettings.regularModeMouse = enabled;
    this.markModified("regularModeMouse");
    this.save();
}
```

Wiring: read it in `createInteractiveTui()` and pass a `mouse?: boolean` option into the
`TuiMainScreen` constructor, matching the existing `TuiAltScreenOptions.mouse` flag
(`tui-alt-screen.ts:158`), which already defaults to `true` via `options.mouse ?? true`.

Naming alternatives, if `regularModeMouse` reads poorly: `mouseInRegularMode`,
`clickToPositionCursor`, or nesting it under the existing `terminal` settings object as
`terminal.captureMouse`.

Open question for whoever picks this up: should the setting be a tri-state
(`"off" | "on" | "auto"`) where `auto` enables it only when a modifier-bypass is known to
work for the detected terminal? That avoids silently degrading selection on terminals with
no bypass, at the cost of a detection table to maintain.

## Recommendation

Leave regular mode as-is until a user actually asks for it. The current change already
covers fullscreen mode, where mouse capture is free because pi owns selection there.
If it is picked up, ship it opt-in and document the modifier bypass in the same change.
