import { describe, expect, it } from "vitest";

import { isMiddleClick, MouseInputScanner, type MouseInputEvent } from "../src/mouse-input.ts";

function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
}

function firstEvent(chunk: string): MouseInputEvent | undefined {
  return new MouseInputScanner().push(chunk)[0];
}

describe("MouseInputScanner", () => {
  it("decodes a middle-button press with zero-based coordinates", () => {
    expect(firstEvent(sgr(1, 5, 12))).toEqual({
      button: "middle",
      pressed: true,
      x: 4,
      y: 11,
      shift: false,
      alt: false,
      ctrl: false,
      motion: false,
      wheel: false,
    });
  });

  it("maps button codes and the release terminator", () => {
    expect(firstEvent(sgr(0, 1, 1))?.button).toBe("left");
    expect(firstEvent(sgr(2, 1, 1))?.button).toBe("right");
    expect(firstEvent(sgr(3, 1, 1))?.button).toBe("none");
    expect(firstEvent(sgr(0, 1, 1, true))?.pressed).toBe(false);
  });

  it("keeps modifier flags", () => {
    const event = firstEvent(sgr(1 + 16, 1, 1));
    expect(event?.button).toBe("middle");
    expect(event?.ctrl).toBe(true);
  });

  it("marks wheel and motion sequences", () => {
    const wheel = firstEvent(sgr(64, 1, 1));
    expect(wheel?.wheel).toBe(true);
    expect(wheel?.button).toBe("none");

    const drag = firstEvent(sgr(1 + 32, 1, 1));
    expect(drag?.motion).toBe(true);
    expect(drag?.button).toBe("middle");
  });

  it("returns every event in a chunk and ignores the text around them", () => {
    const scanner = new MouseInputScanner();
    const events = scanner.push(`hi${sgr(0, 1, 1)}${sgr(0, 1, 1, true)}there`);
    expect(events.map((event) => [event.button, event.pressed])).toEqual([
      ["left", true],
      ["left", false],
    ]);
    expect(scanner.push("plain text")).toEqual([]);
  });

  it("reassembles a sequence split across chunks", () => {
    const scanner = new MouseInputScanner();
    const sequence = sgr(1, 3, 4);

    expect(scanner.push(sequence.slice(0, 4))).toEqual([]);
    expect(scanner.push(sequence.slice(4)).map((event) => event.button)).toEqual(["middle"]);
  });

  it("reassembles a sequence split at every offset", () => {
    const sequence = sgr(1, 12, 34);
    for (let split = 1; split < sequence.length; split += 1) {
      const scanner = new MouseInputScanner();
      const events = [...scanner.push(sequence.slice(0, split)), ...scanner.push(sequence.slice(split))];
      expect(events).toHaveLength(1);
    }
  });

  it("forgets tails that cannot grow into a mouse sequence", () => {
    const scanner = new MouseInputScanner();
    expect(scanner.push("\x1bOP")).toEqual([]);
    expect(scanner.push(sgr(1, 1, 1))).toHaveLength(1);
  });

  it("drops a pending partial on reset", () => {
    const scanner = new MouseInputScanner();
    scanner.push("\x1b[<1");
    scanner.reset();
    expect(scanner.push(";2;3M")).toEqual([]);
  });
});

describe("isMiddleClick", () => {
  const events = new MouseInputScanner();
  const eventFor = (chunk: string): MouseInputEvent => {
    const event = events.push(chunk)[0];
    if (!event) throw new Error("expected a mouse event");
    return event;
  };

  it("is true only for a middle-button press", () => {
    expect(isMiddleClick(eventFor(sgr(1, 1, 1)))).toBe(true);
    expect(isMiddleClick(eventFor(sgr(17, 1, 1)))).toBe(true);
  });

  it("is false for releases, other buttons, wheel turns, and motion", () => {
    expect(isMiddleClick(eventFor(sgr(1, 1, 1, true)))).toBe(false);
    expect(isMiddleClick(eventFor(sgr(0, 1, 1)))).toBe(false);
    expect(isMiddleClick(eventFor(sgr(2, 1, 1)))).toBe(false);
    expect(isMiddleClick(eventFor(sgr(64, 1, 1)))).toBe(false);
    expect(isMiddleClick(eventFor(sgr(65, 1, 1)))).toBe(false);
    expect(isMiddleClick(eventFor(sgr(1 + 32, 1, 1)))).toBe(false);
  });
});
