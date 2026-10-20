import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { MiddleClickPasteController, type ExtensionUi } from "../src/controller.ts";
import type { MouseInputStream } from "../src/middle-click.ts";
import {
  NO_BACKEND_ERROR,
  type PrimaryRead,
  type PrimarySelection,
  type PrimaryWrite,
} from "../src/primary-clipboard.ts";
import type { PointerEventLike } from "../src/pointer-event.ts";

/** In-memory stand-in for the desktop primary selection. */
class FakeClipboard implements PrimarySelection {
  owned: string | undefined;
  hasBackend = true;
  readFails = false;
  writeFails = false;
  reads = 0;
  writes = 0;

  available(): boolean {
    return this.hasBackend;
  }

  describe(): { paste: string; copy: string } | undefined {
    return this.hasBackend ? { paste: "fake-paste", copy: "fake-copy" } : undefined;
  }

  async read(): Promise<PrimaryRead> {
    this.reads += 1;
    if (this.readFails || !this.hasBackend) {
      return { status: "unavailable", error: NO_BACKEND_ERROR };
    }
    if (this.owned === undefined) return { status: "empty", backend: "fake-paste" };
    return { status: "text", text: this.owned, backend: "fake-paste" };
  }

  async write(text: string): Promise<PrimaryWrite> {
    this.writes += 1;
    if (!this.hasBackend || this.writeFails) {
      return { status: "unavailable", error: NO_BACKEND_ERROR };
    }
    if (text.length === 0) return { status: "skipped", reason: "nothing was selected" };
    this.owned = text;
    return { status: "written", backend: "fake-copy" };
  }
}

interface FakeUi extends ExtensionUi {
  notices: Array<{ message: string; level: string | undefined }>;
  pasted: string[];
}

function createUi(): FakeUi {
  return {
    notices: [],
    pasted: [],
    notify(message: string, level?: "info" | "warning" | "error") {
      this.notices.push({ message, level });
    },
    pasteToEditor(text: string) {
      this.pasted.push(text);
    },
  };
}

interface FakeTui {
  selected: string | undefined;
  getActiveSelectionText(): string | undefined;
  handleSelectionMouseEvent(event: PointerEventLike): void;
}

function createTui(selected = "text from pi"): FakeTui {
  const tui: FakeTui = {
    selected,
    getActiveSelectionText() {
      return tui.selected;
    },
    handleSelectionMouseEvent() {
      // Pi's own selection handling; irrelevant to these tests.
    },
  };
  return tui;
}

function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
}

/** A middle-button press in the editor area. */
const MIDDLE_PRESS = sgr(1, 4, 2);

function releaseEvent(button = 0): PointerEventLike {
  return { button, x: 1, y: 1, release: true };
}

function createController(clipboard = new FakeClipboard(), stdin = new EventEmitter()) {
  const controller = new MiddleClickPasteController({ clipboard, stdin, testSettleMs: 0 });
  return { controller, clipboard, stdin: stdin as EventEmitter & MouseInputStream };
}

describe("middle-click paste", () => {
  it("pastes the primary selection into the editor", async () => {
    const { controller, clipboard, stdin } = createController();
    const ui = createUi();
    controller.attach(ui, createTui());

    clipboard.owned = "copied from another app";
    stdin.emit("data", MIDDLE_PRESS);
    await vi.waitFor(() => expect(ui.pasted).toEqual(["copied from another app"]));
    expect(ui.notices).toEqual([]);

    controller.detach();
  });

  it("warns once when the primary selection is empty", async () => {
    const { controller, stdin } = createController();
    const ui = createUi();
    controller.attach(ui, createTui());

    stdin.emit("data", MIDDLE_PRESS);
    stdin.emit("data", MIDDLE_PRESS);
    await vi.waitFor(() => expect(ui.notices).toHaveLength(1));

    expect(ui.pasted).toEqual([]);
    expect(ui.notices[0]?.message).toContain("empty");
    expect(ui.notices[0]?.level).toBe("warning");

    controller.detach();
  });

  it("warns once when the primary selection cannot be read", async () => {
    const { controller, clipboard, stdin } = createController();
    clipboard.readFails = true;
    const ui = createUi();
    controller.attach(ui, createTui());

    stdin.emit("data", MIDDLE_PRESS);
    await vi.waitFor(() => expect(ui.notices).toHaveLength(1));

    expect(ui.notices[0]?.message).toContain(NO_BACKEND_ERROR);
    expect(clipboard.reads).toBe(1);

    controller.detach();
  });

  it("stops watching once detached", () => {
    const { controller, clipboard, stdin } = createController();
    const ui = createUi();
    controller.attach(ui, createTui());
    clipboard.owned = "text";
    controller.detach();

    stdin.emit("data", MIDDLE_PRESS);
    expect(ui.pasted).toEqual([]);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});

describe("selection copy-out", () => {
  it("publishes a finished selection without notifying", () => {
    const { controller, clipboard } = createController();
    const ui = createUi();
    const tui = createTui("copied out of pi");
    controller.attach(ui, tui);

    tui.handleSelectionMouseEvent(releaseEvent());

    expect(clipboard.owned).toBe("copied out of pi");
    expect(ui.notices).toEqual([]);
    expect(ui.pasted).toEqual([]);

    controller.detach();
  });

  it("does not publish presses", () => {
    const { controller, clipboard } = createController();
    const ui = createUi();
    const tui = createTui();
    controller.attach(ui, tui);

    tui.handleSelectionMouseEvent({ button: 0, x: 1, y: 1, release: false });

    expect(clipboard.writes).toBe(0);

    controller.detach();
  });

  it("warns once when the selection cannot be published", async () => {
    const { controller, clipboard } = createController();
    clipboard.writeFails = true;
    const ui = createUi();
    const tui = createTui();
    controller.attach(ui, tui);

    tui.handleSelectionMouseEvent(releaseEvent());
    await vi.waitFor(() => expect(ui.notices).toHaveLength(1));
    tui.handleSelectionMouseEvent(releaseEvent());
    await Promise.resolve();

    expect(ui.notices).toHaveLength(1);
    expect(ui.notices[0]?.message).toContain("copy-out failed");

    controller.detach();
  });

  it("restores Pi's handler on detach", () => {
    const { controller, clipboard } = createController();
    const ui = createUi();
    const tui = createTui();
    const pristine = tui.handleSelectionMouseEvent;
    controller.attach(ui, tui);
    controller.detach();

    expect(tui.handleSelectionMouseEvent).toBe(pristine);
    tui.handleSelectionMouseEvent(releaseEvent());
    expect(clipboard.writes).toBe(0);
  });

  it("still pastes when copy-out is unsupported, and says so once", async () => {
    const { controller, clipboard, stdin } = createController();
    const ui = createUi();
    controller.attach(ui, {});

    expect(ui.notices[0]?.message).toContain("does not expose transcript selection");

    clipboard.owned = "text";
    stdin.emit("data", MIDDLE_PRESS);
    await vi.waitFor(() => expect(ui.pasted).toEqual(["text"]));
    expect(controller.statusLine()).toContain("copy-out unsupported");

    controller.detach();
  });
});

describe("/mcpaste", () => {
  it("reports status", async () => {
    const { controller } = createController();
    const ui = createUi();

    await controller.handleCommand("", ui, createTui());
    expect(ui.notices[0]).toEqual({
      message: "middle-click paste: on · paste: fake-paste · copy: fake-copy",
      level: "info",
    });

    await controller.handleCommand(undefined, ui, createTui());
    expect(ui.notices[1]?.message).toContain("on");
  });

  it("names the missing tooling when there is no backend", async () => {
    const clipboard = new FakeClipboard();
    clipboard.hasBackend = false;
    const { controller } = createController(clipboard);
    const ui = createUi();

    await controller.handleCommand("status", ui, createTui());
    expect(ui.notices[0]?.message).toContain(NO_BACKEND_ERROR);
  });

  it("toggles off and on", async () => {
    const { controller, clipboard, stdin } = createController();
    const ui = createUi();
    const tui = createTui();
    controller.attach(ui, tui);
    clipboard.owned = "text";

    await controller.handleCommand("off", ui, tui);
    expect(ui.notices[0]?.message).toContain("off");
    expect(stdin.listenerCount("data")).toBe(0);

    stdin.emit("data", MIDDLE_PRESS);
    tui.handleSelectionMouseEvent(releaseEvent());
    expect(ui.pasted).toEqual([]);
    expect(clipboard.writes).toBe(0);

    await controller.handleCommand("on", ui, tui);
    expect(ui.notices[1]?.message).toContain("on");
    expect(stdin.listenerCount("data")).toBe(1);

    stdin.emit("data", MIDDLE_PRESS);
    await vi.waitFor(() => expect(ui.pasted).toEqual(["text"]));

    controller.detach();
  });

  it("ignores a redundant toggle", async () => {
    const { controller, stdin } = createController();
    const ui = createUi();
    controller.attach(ui, createTui());

    await controller.handleCommand("on", ui, createTui());
    expect(stdin.listenerCount("data")).toBe(1);
    expect(ui.notices).toHaveLength(1);

    controller.detach();
  });

  it("round-trips the primary selection on test", async () => {
    const { controller, clipboard } = createController();
    const ui = createUi();

    await controller.handleCommand("test", ui, createTui());

    expect(ui.notices[0]?.level).toBe("info");
    expect(ui.notices[0]?.message).toContain("primary selection works");
    expect(clipboard.owned).toContain("pi-middle-click-paste");
  });

  it("reports a failed round trip on test", async () => {
    const { controller, clipboard } = createController();
    clipboard.readFails = true;
    const ui = createUi();

    await controller.handleCommand("test", ui, createTui());

    expect(ui.notices[0]?.level).toBe("warning");
    expect(ui.notices[0]?.message).toContain("could not read it back");
  });

  it("rejects unknown arguments", async () => {
    const { controller } = createController();
    const ui = createUi();

    await controller.handleCommand("sideways", ui, createTui());

    expect(ui.notices[0]?.level).toBe("error");
    expect(ui.notices[0]?.message).toContain("usage: /mcpaste");
  });
});

describe("attach lifecycle", () => {
  it("replaces the previous session's wiring on re-attach", async () => {
    const { controller, clipboard, stdin } = createController();
    const first = createUi();
    const second = createUi();
    const firstTui = createTui();
    const secondTui = createTui();

    controller.attach(first, firstTui);
    controller.attach(second, secondTui);
    clipboard.owned = "text";

    stdin.emit("data", MIDDLE_PRESS);
    await vi.waitFor(() => expect(second.pasted).toEqual(["text"]));
    expect(first.pasted).toEqual([]);

    secondTui.handleSelectionMouseEvent(releaseEvent());
    expect(firstTui.handleSelectionMouseEvent).not.toBe(secondTui.handleSelectionMouseEvent);

    controller.detach();
  });

  it("tolerates detaching twice", () => {
    const { controller } = createController();
    controller.attach(createUi(), createTui());
    controller.detach();
    expect(() => controller.detach()).not.toThrow();
  });
});
