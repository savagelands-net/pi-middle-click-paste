import { describe, expect, it, vi } from "vitest";

import { mirrorSelectionOnRelease } from "../src/selection-mirror.ts";
import type { PointerEventLike } from "../src/pointer-event.ts";

interface FakeTui {
  selected: string | undefined;
  handled: PointerEventLike[];
  getActiveSelectionText(): string | undefined;
  handleSelectionMouseEvent(event: PointerEventLike): void;
}

function fakeTui(selected: string | undefined = "selected text"): FakeTui {
  const tui: FakeTui = {
    selected,
    handled: [],
    getActiveSelectionText() {
      return tui.selected;
    },
    handleSelectionMouseEvent(event) {
      tui.handled.push(event);
    },
  };
  return tui;
}

function press(button = 0): PointerEventLike {
  return { button, x: 1, y: 1, release: false };
}

function release(button = 0): PointerEventLike {
  return { button, x: 1, y: 1, release: true };
}

describe("mirrorSelectionOnRelease", () => {
  it("reports the selection when a drag finishes and leaves Pi's handler in charge", () => {
    const tui = fakeTui("copied out");
    const onSelection = vi.fn();
    mirrorSelectionOnRelease(tui, { onSelection });

    tui.handleSelectionMouseEvent(press());
    expect(onSelection).not.toHaveBeenCalled();

    tui.handleSelectionMouseEvent(release());
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenCalledWith("copied out");
    // Both events still reached the original handler.
    expect(tui.handled).toHaveLength(2);
  });

  it("accepts the legacy release marker", () => {
    const tui = fakeTui("x");
    const onSelection = vi.fn();
    mirrorSelectionOnRelease(tui, { onSelection });
    tui.handleSelectionMouseEvent(release(3));
    expect(onSelection).toHaveBeenCalledWith("x");
  });

  it("stays silent when nothing is selected", () => {
    for (const selected of [undefined, ""]) {
      const tui = fakeTui();
      tui.selected = selected;
      const onSelection = vi.fn();
      mirrorSelectionOnRelease(tui, { onSelection });
      tui.handleSelectionMouseEvent(release());
      expect(onSelection).not.toHaveBeenCalled();
    }
  });

  it("reports failures without breaking the host handler", () => {
    const tui = fakeTui();
    tui.getActiveSelectionText = () => {
      throw new Error("selection vanished");
    };
    const onError = vi.fn();
    const onSelection = vi.fn();
    mirrorSelectionOnRelease(tui, { onSelection, onError });

    expect(() => tui.handleSelectionMouseEvent(release())).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(tui.handled).toHaveLength(1);
  });

  it("restores the original handler", () => {
    const tui = fakeTui("text");
    const pristine = tui.handleSelectionMouseEvent;
    const onSelection = vi.fn();
    const handle = mirrorSelectionOnRelease(tui, { onSelection });
    expect(handle.supported).toBe(true);

    handle.restore();
    expect(tui.handleSelectionMouseEvent).toBe(pristine);

    tui.handleSelectionMouseEvent(release());
    expect(onSelection).not.toHaveBeenCalled();
    expect(tui.handled).toHaveLength(1);
  });

  it("installs a single wrapper when called twice", () => {
    const tui = fakeTui("text");
    const pristine = tui.handleSelectionMouseEvent;
    const first = vi.fn();
    const second = vi.fn();

    mirrorSelectionOnRelease(tui, { onSelection: first });
    const handle = mirrorSelectionOnRelease(tui, { onSelection: second });

    tui.handleSelectionMouseEvent(release());
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(tui.handled).toHaveLength(1);

    handle.restore();
    expect(tui.handleSelectionMouseEvent).toBe(pristine);
  });

  it("does not clobber a handler installed after it", () => {
    const tui = fakeTui("text");
    const handle = mirrorSelectionOnRelease(tui, { onSelection: vi.fn() });
    const later = vi.fn();
    tui.handleSelectionMouseEvent = later;

    handle.restore();
    expect(tui.handleSelectionMouseEvent).toBe(later);
  });

  it("reports unsupported prototypes instead of patching them", () => {
    const onSelection = vi.fn();

    const empty = {} as Partial<FakeTui>;
    const handle = mirrorSelectionOnRelease(empty, { onSelection });
    expect(handle.supported).toBe(false);
    expect(() => handle.restore()).not.toThrow();

    const noText = { handleSelectionMouseEvent: vi.fn() } as unknown as Partial<FakeTui>;
    expect(mirrorSelectionOnRelease(noText, { onSelection }).supported).toBe(false);

    const noHandler = { getActiveSelectionText: () => "x" } as unknown as Partial<FakeTui>;
    expect(mirrorSelectionOnRelease(noHandler, { onSelection }).supported).toBe(false);
  });
});
