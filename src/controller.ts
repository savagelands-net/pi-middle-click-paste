/**
 * Wiring between the terminal, Pi's UI, and the primary selection.
 *
 * Kept free of Pi imports so the behaviour around middle-click paste, selection
 * copy-out, and the `/mcpaste` command can be exercised directly.
 */

import {
  NO_BACKEND_ERROR,
  PrimaryClipboard,
  type PrimaryRead,
  type PrimarySelection,
  type PrimaryWrite,
} from "./primary-clipboard.ts";
import { watchMiddleClick, type MouseInputStream } from "./middle-click.ts";
import { mirrorSelectionOnRelease, type SelectionMirrorHandle } from "./selection-mirror.ts";

/** The UI methods this extension needs from Pi. */
export interface ExtensionUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  pasteToEditor(text: string): void;
  /**
   * Repaint the terminal.
   *
   * Pi renders as part of handling its own input, so text injected from an
   * async callback stays in the editor buffer, invisible, until the next key
   * press forces a frame.
   */
  refreshView(): void;
}

export interface ControllerOptions {
  /** Test seam; production drives the real desktop primary selection. */
  clipboard?: PrimarySelection | undefined;
  /** Defaults to `process.stdin`; injectable for tests. */
  stdin?: MouseInputStream | undefined;
  /** Delay before re-reading the selection in `/mcpaste test`, in ms. */
  testSettleMs?: number;
}

const USAGE = "usage: /mcpaste [status|on|off|test]";
const UNSUPPORTED_COPY_OUT =
  "copy-out is unavailable: this Pi version does not expose transcript selection. Middle-click paste still works";

type CopyOutHealth = "unknown" | "ok" | "missing" | "failing";

/** What `/mcpaste status` appends for each copy-out state. */
const COPY_OUT_STATUS: Record<CopyOutHealth, string> = {
  unknown: "",
  ok: "",
  missing: " (copy-out unsupported)",
  failing: " (copy-out failing)",
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export class MiddleClickPasteController {
  private readonly clipboard: PrimarySelection;
  private readonly stdin: MouseInputStream | undefined;
  private readonly testSettleMs: number;
  /** Notification kinds already shown, so a broken setup is reported once. */
  private readonly warned = new Set<string>();
  private ui: ExtensionUi | undefined;
  private mirror: SelectionMirrorHandle | undefined;
  private disposeWatch: (() => void) | undefined;
  /** What the last copy-out attempt told us, for status reporting. */
  private copyOut: CopyOutHealth = "unknown";
  private enabled = true;
  /** Bumped on every teardown so in-flight clipboard reads cannot paste late. */
  private generation = 0;

  constructor(options: ControllerOptions = {}) {
    this.clipboard = options.clipboard ?? new PrimaryClipboard();
    this.stdin = options.stdin;
    this.stdin = options.stdin;
    this.testSettleMs = options.testSettleMs ?? 50;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  statusLine(): string {
    const state = this.enabled ? "on" : "off";
    const backends = this.clipboard.describe();
    if (!backends) return `middle-click paste: ${state} - ${NO_BACKEND_ERROR}`;
    const broken = COPY_OUT_STATUS[this.copyOut];
    return `middle-click paste: ${state} · paste: ${backends.paste} · copy: ${backends.copy}${broken}`;
  }

  /**
   * Start watching for middle-clicks and mirroring selections. Safe to call on
   * every session start: the previous wiring is torn down first, so a session
   * reload cannot stack watchers or selection handlers.
   */
  attach(ui: ExtensionUi, tuiPrototype: unknown): void {
    this.detach();
    if (!this.enabled) return;
    this.ui = ui;
    this.copyOut = "unknown";

    // Mirror the selection first: a session restored with text still selected
    // should reach the primary selection even without a new mouse release.
    try {
      this.mirror = mirrorSelectionOnRelease(tuiPrototype, {
        onSelection: (text) => {
          void this.mirrorSelection(text);
        },
        onError: (error) => {
          this.warnOnce("mirror", ui, `copy-out failed: ${describeError(error)}`);
        },
      });
      if (!this.mirror.supported) {
        this.copyOut = "missing";
        this.warnOnce("unsupported", ui, UNSUPPORTED_COPY_OUT);
      }
    } catch (error) {
      this.mirror = undefined;
      this.copyOut = "missing";
      this.warnOnce("unsupported", ui, `${UNSUPPORTED_COPY_OUT} (${describeError(error)})`);
    }

    this.disposeWatch = watchMiddleClick({
      stdin: this.stdin,
      onMiddleClick: () => {
        void this.pastePrimary();
      },
    });
  }

  detach(): void {
    this.generation += 1;
    this.disposeWatch?.();
    this.disposeWatch = undefined;
    this.mirror?.restore();
    this.mirror = undefined;
    this.ui = undefined;
    this.copyOut = "unknown";
  }

  setEnabled(enabled: boolean, ui: ExtensionUi, tuiPrototype: unknown): void {
    if (enabled === this.enabled) {
      ui.notify(this.statusLine(), "info");
      return;
    }
    this.enabled = enabled;
    if (enabled) {
      this.attach(ui, tuiPrototype);
    } else {
      this.detach();
    }
    ui.notify(this.statusLine(), "info");
  }

  async handleCommand(
    args: string | undefined,
    ui: ExtensionUi,
    tuiPrototype: unknown,
  ): Promise<void> {
    const sub = (args ?? "").trim().toLowerCase();
    if (sub === "" || sub === "status") {
      ui.notify(this.statusLine(), "info");
      return;
    }
    if (sub === "on" || sub === "off") {
      this.setEnabled(sub === "on", ui, tuiPrototype);
      return;
    }
    if (sub === "test") {
      await this.runSelfTest(ui);
      return;
    }
    ui.notify(USAGE, "error");
  }

  /** Read the primary selection and drop it into the editor like a real middle-click would. */
  async pastePrimary(): Promise<void> {
    const ui = this.ui;
    if (!ui) return;
    const generation = this.generation;
    const result: PrimaryRead = await this.clipboard.read();
    // A pending click must not paste into a torn-down or replaced session.
    if (generation !== this.generation) return;
    if (result.status === "text") {
      this.warned.delete("read");
      ui.pasteToEditor(result.text);
      ui.refreshView();
      return;
    }
    if (result.status === "empty") {
      // Nothing selected explains the failed read on its own when there is no
      // tool to tell the two apart, so never also claim the tooling is broken.
      this.warned.add("read");
      this.warnOnce("empty", ui, "primary selection is empty: select some text first");
      return;
    }
    this.warnOnce("read", ui, `middle-click paste: ${result.error}`);
  }

  /** Publish a finished selection as the primary selection, without any notice. */
  async mirrorSelection(text: string): Promise<void> {
    const result: PrimaryWrite = await this.clipboard.write(text);
    this.copyOut = result.status === "unavailable" ? "failing" : "ok";
    if (result.status === "unavailable") {
      const ui = this.ui;
      if (ui) this.warnOnce("write", ui, `copy-out failed: ${result.error}`);
    }
  }

  private async runSelfTest(ui: ExtensionUi): Promise<void> {
    if (!this.clipboard.available()) {
      ui.notify(`middle-click paste: ${NO_BACKEND_ERROR}`, "error");
      return;
    }
    const marker = `pi-middle-click-paste ${Date.now()}`;
    const written = await this.clipboard.write(marker);
    if (written.status === "unavailable") {
      ui.notify(`middle-click paste test: ${written.error}`, "error");
      return;
    }
    if (written.status === "skipped") {
      ui.notify(`middle-click paste test: nothing to write (${written.reason})`, "warning");
      return;
    }
    // Give the clipboard owner time to publish its offer before reading it back.
    await delay(this.testSettleMs);
    const read = await this.clipboard.read();
    if (read.status === "text" && read.text === marker) {
      ui.notify(`middle-click paste test: primary selection works (${read.backend})`, "info");
      return;
    }
    const seen = read.status === "text" ? "different text" : read.status;
    ui.notify(
      `middle-click paste test: wrote the primary selection but could not read it back (${seen})`,
      "warning",
    );
  }

  private warnOnce(kind: string, ui: ExtensionUi | undefined, message: string): void {
    if (!ui || this.warned.has(kind)) return;
    this.warned.add(kind);
    ui.notify(message, "warning");
  }
}
