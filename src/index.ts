/**
 * pi-middle-click-paste
 *
 * Makes Linux middle-click copy/paste work inside Pi's fullscreen terminal:
 * text selected in another app pastes into Pi with a middle-click, and text
 * selected in Pi can be middle-clicked out into another app.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

import { MiddleClickPasteController, type ExtensionUi } from "./controller.ts";

const COMMANDS = ["middle-click-paste", "mcpaste"] as const;

/**
 * Adapt Pi's UI context to the narrow interface the controller needs.
 *
 * Pi paints frames as part of handling terminal input, so a paste injected from
 * a clipboard callback lands in the editor buffer without ever reaching the
 * screen — it shows up on the user's next key press. The UI context hands an
 * extension the TUI only through `custom()`, which is what Pi's own extensions
 * use to force a frame, so borrow it there and render immediately.
 */
function createUi(ui: ExtensionUIContext): ExtensionUi {
  const repaint = () => {
    void ui
      .custom<void>((tui, _theme, _keybindings, done) => {
        tui.requestRender();
        done(undefined);
        // An empty component: the frame we just asked for is the whole point.
        return { render: () => [], invalidate: () => undefined };
      })
      .catch(() => undefined);
  };

  return {
    notify: (message, level) => ui.notify(message, level),
    pasteToEditor: (text) => ui.pasteToEditor(text),
    refreshView: repaint,
  };
}

export default function (pi: ExtensionAPI): void {
  const controller = new MiddleClickPasteController();

  // Mouse capture and selection mirroring only make sense in the fullscreen TUI.
  const sync = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") {
      controller.detach();
      return;
    }
    controller.attach(createUi(ctx.ui), TuiAltScreen.prototype);
  };

  for (const command of COMMANDS) {
    pi.registerCommand(command, {
      description:
        command === "middle-click-paste"
          ? "Inspect or control middle-click primary-selection copy/paste"
          : "Alias for /middle-click-paste",
      handler: async (args: string, ctx: ExtensionCommandContext) =>
        controller.handleCommand(args, createUi(ctx.ui), TuiAltScreen.prototype),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    sync(ctx);
  });

  pi.on("session_shutdown", async () => {
    controller.detach();
  });
}
