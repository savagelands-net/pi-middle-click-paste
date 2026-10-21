# @savagelands-net/pi-middle-click-paste

Pi extension that makes Linux middle-click copy/paste work inside Pi's fullscreen terminal, in both directions:

- select text **somewhere else**, then middle-click inside Pi to paste it
- select text **in Pi's transcript**, then middle-click it into another app or terminal

## Why Pi needs help with this

On Linux, middle-click pastes the **primary selection** - the text you selected with the mouse, which is separate from the Ctrl+C/Ctrl+V clipboard. Pi's fullscreen terminal breaks both halves of that:

1. **Pasting into Pi.** In fullscreen mode Pi enables terminal mouse tracking (`?1000`/`?1002`/`?1003`/`?1006`) so it can handle clicks and drags itself. Once an application asks for mouse events, the terminal stops treating the pointer as its own, so Konsole's "paste on middle-click" never runs - the click reaches Pi as an SGR escape sequence and Pi has no use for the middle button. This is why Konsole documents middle-click paste as "does not work with most TUIs".
2. **Copying out of Pi.** The transcript selection is drawn by Pi, not by the terminal, so the terminal has nothing to paste. Pi also puts a selection on the **clipboard** (what `Ctrl+Shift+V` pastes) rather than on the **primary selection**, so middle-clicking into another app pastes whatever you last selected with the mouse somewhere else.

This extension supplies both halves: a middle-click that reaches Pi becomes a primary-selection paste, and every selection you finish in Pi becomes the primary selection.

## Install

From npm:

```bash
pi install npm:@savagelands-net/pi-middle-click-paste
```

Or straight from the repository:

```bash
pi install git:github.com/savagelands-net/pi-middle-click-paste
```

Then restart Pi or run `/reload`. To try it for a single run without installing:

```bash
pi -e npm:@savagelands-net/pi-middle-click-paste
```

## Requirements

- Linux with a Wayland or X11 session
- a terminal that reports the pointer as SGR (xterm 1006) mouse sequences: Konsole, GNOME Terminal, kitty, WezTerm, Alacritty, and similar
- one of these clipboard tools:

| Session | Tool | Package |
| --- | --- | --- |
| Wayland | `wl-copy` / `wl-paste` | `wl-clipboard` |
| X11 | `xclip` | `xclip` |
| X11 | `xsel` | `xsel` |

Wayland is used first when both `$WAYLAND_DISPLAY` and `$DISPLAY` are set, as they are on a KDE or GNOME Wayland session, because the compositor shares its primary selection with X11 clients.

## Usage

| Gesture | Result |
| --- | --- |
| Select text in another app, middle-click in Pi's editor | the text is inserted at the cursor |
| Drag to select transcript text in Pi | that text becomes the primary selection |
| Middle-click in another app | pastes what you selected in Pi |

`/mcpaste` (or `/middle-click-paste`) inspects and controls the extension:

```text
/mcpaste            # status: on/off plus the commands used to paste and copy
/mcpaste status     # same
/mcpaste on         # watch again
/mcpaste off        # stop, and give Pi's own handling back untouched
/mcpaste test       # write a marker to the primary selection and read it back
```

Problems are reported once per session, so a missing tool does not repeat itself on every click.

## How it works

**Middle-click in, paste.** Pi consumes mouse sequences inside its own input pipeline, so an extension terminal-input listener never sees them. The extension adds a read-only `data` listener to `process.stdin` - the same stream Pi reads - scans it for middle-button presses, and on one runs the primary-selection reader (`wl-paste --primary --no-newline`, `xclip -selection primary -out`, or `xsel --primary --output`) and hands the text to `ctx.ui.pasteToEditor()`, which inserts it as a bracketed paste. Keystrokes, other buttons, wheel turns, and Pi's own handling of the same bytes are untouched, and the stream is never paused or re-encoded. Sequences split across stdin chunks are reassembled.

**Selection out, mirror.** `handleSelectionMouseEvent` on `TuiAltScreen.prototype` (the fullscreen TUI class from `@earendil-works/pi-tui`) is wrapped so that after Pi finishes handling a drag release, `getActiveSelectionText()` is read and published with `wl-copy --primary`, `xclip -selection primary`, or `xsel --primary --input`. Nothing about Pi's behaviour changes: copy-on-select still fills the regular clipboard, `ctrl+shift+c` still works, and the wrapper is removed again by `/mcpaste off` and on session shutdown. Selecting in Pi does not touch the Ctrl+C clipboard.

Three details that matter on a real desktop:

- the clipboard tools are spawned detached, in their own process group, and are resolved as soon as the tool exits - they fork a background owner that inherits the descriptors, so waiting for the pipes to close would stall every copy and a `Ctrl+C` in Pi's terminal would kill the new selection owner
- a selection nobody owns cannot block forever: every clipboard command runs under a timeout, and a tool that fails once is skipped on later clicks
- Pi paints a frame as part of handling its own input, so text injected from a clipboard callback would sit in the editor buffer until the next key press. After a paste the extension borrows the TUI through `ctx.ui.custom()` and asks for a frame, so the text is on screen in the same instant as the click

## Notes and limits

- Fullscreen only. In `--tui-mode regular` Pi does not grab the mouse, so the terminal's own middle-click paste still works and there is nothing to intercept.
- Load it once. If the same extension is loaded twice, for example `pi install` plus `--extension ./src/index.ts`, each copy watches stdin and you get two pastes per click.
- Only the primary selection is read or written. `Ctrl+Shift+C`, `Ctrl+Shift+V`, and anything already on the regular clipboard are left alone.
- Selecting text in Pi republishes the primary selection, exactly like selecting text anywhere else on an X11 or Wayland desktop.
- Pasting works while Pi is answering: the text lands in the editor and waits for Enter like anything you type there.
- A middle-click anywhere in Pi's fullscreen window pastes, including over the scroll area - Pi has no use for the middle button, so it is treated as "paste here".
- If middle-click pastes nowhere in your desktop, the selection clipboard is switched off at the desktop level (KDE: System Settings -> Clipboard -> Enable selection).
- If middle-click works in other apps but not into Pi, check the terminal's own middle-click or mouse-paste settings; the gesture has to reach the terminal as a mouse event.
- Wayland needs a compositor with the primary-selection offer (`wl-clipboard` calls it the "primary clipboard"); KDE and GNOME provide it.

## Development

```bash
npm install
npm test              # unit tests, no desktop session needed
npm run typecheck
PI_MIDDLE_CLICK_PASTE_LIVE=1 npx vitest run   # round-trip the real primary selection, then restore it
```

## License

MIT
