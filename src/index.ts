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
} from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

import { MiddleClickPasteController } from "./controller.ts";

const COMMANDS = ["middle-click-paste", "mcpaste"] as const;

export default function (pi: ExtensionAPI): void {
  const controller = new MiddleClickPasteController();

  // Mouse capture and selection mirroring only make sense in the fullscreen TUI.
  const sync = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") {
      controller.detach();
      return;
    }
    controller.attach(ctx.ui, TuiAltScreen.prototype);
  };

  for (const command of COMMANDS) {
    pi.registerCommand(command, {
      description:
        command === "middle-click-paste"
          ? "Inspect or control middle-click primary-selection copy/paste"
          : "Alias for /middle-click-paste",
      handler: async (args: string, ctx: ExtensionCommandContext) =>
        controller.handleCommand(args, ctx.ui, TuiAltScreen.prototype),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    sync(ctx);
  });

  pi.on("session_shutdown", async () => {
    controller.detach();
  });
}
