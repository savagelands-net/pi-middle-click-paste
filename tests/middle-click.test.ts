import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { watchMiddleClick } from "../src/middle-click.ts";
import type { MouseInputStream } from "../src/middle-click.ts";

function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
}

function createStdin(): EventEmitter & MouseInputStream {
  return new EventEmitter() as EventEmitter & MouseInputStream;
}

describe("watchMiddleClick", () => {
  it("reports middle presses from buffers and strings alike", () => {
    const stdin = createStdin();
    const columns: number[] = [];
    watchMiddleClick({ stdin, onMiddleClick: (event) => columns.push(event.x) });

    stdin.emit("data", Buffer.from(sgr(1, 7, 3)));
    stdin.emit("data", sgr(1, 9, 3));

    expect(columns).toEqual([6, 8]);
  });

  it("reports a press whose sequence is split across chunks", () => {
    const stdin = createStdin();
    const onMiddleClick = vi.fn();
    watchMiddleClick({ stdin, onMiddleClick });

    const sequence = sgr(1, 12, 3);
    stdin.emit("data", sequence.slice(0, 5));
    stdin.emit("data", sequence.slice(5));

    expect(onMiddleClick).toHaveBeenCalledTimes(1);
  });

  it("ignores keyboard input, other buttons, and wheel turns", () => {
    const stdin = createStdin();
    const onMiddleClick = vi.fn();
    watchMiddleClick({ stdin, onMiddleClick });

    stdin.emit("data", "hello\r");
    stdin.emit("data", sgr(0, 1, 1)); // left press
    stdin.emit("data", sgr(2, 1, 1)); // right press
    stdin.emit("data", sgr(1, 1, 1, true)); // middle release
    stdin.emit("data", sgr(65, 1, 1)); // wheel down
    stdin.emit("data", sgr(33, 1, 1)); // middle drag

    expect(onMiddleClick).not.toHaveBeenCalled();
  });

  it("keeps other stdin listeners working", () => {
    const stdin = createStdin();
    const received: string[] = [];
    stdin.on("data", (chunk: string) => received.push(String(chunk)));
    watchMiddleClick({ stdin, onMiddleClick: vi.fn() });

    stdin.emit("data", "typed");

    expect(received).toEqual(["typed"]);
  });

  it("stops reporting after dispose, and dispose is idempotent", () => {
    const stdin = createStdin();
    const onMiddleClick = vi.fn();
    const dispose = watchMiddleClick({ stdin, onMiddleClick });

    stdin.emit("data", sgr(1, 1, 1));
    expect(onMiddleClick).toHaveBeenCalledTimes(1);

    dispose();
    dispose();
    stdin.emit("data", sgr(1, 1, 1));

    expect(onMiddleClick).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
