import { describe, expect, it } from "vitest";

import { isSelectionRelease, type PointerEventLike } from "../src/pointer-event.ts";

function event(button: number, release: boolean): PointerEventLike {
  return { button, x: 1, y: 1, release };
}

describe("isSelectionRelease", () => {
  it("accepts the releases Pi treats as end-of-selection", () => {
    expect(isSelectionRelease(event(0, true))).toBe(true);
    expect(isSelectionRelease(event(4, true))).toBe(true); // left + ctrl
    expect(isSelectionRelease(event(3, true))).toBe(true); // legacy release marker
  });

  it("rejects presses and non-left buttons", () => {
    expect(isSelectionRelease(event(0, false))).toBe(false);
    expect(isSelectionRelease(event(1, true))).toBe(false); // middle
    expect(isSelectionRelease(event(2, true))).toBe(false); // right
    expect(isSelectionRelease(event(3, false))).toBe(false);
    expect(isSelectionRelease(event(64, true))).toBe(false); // wheel
  });
});
