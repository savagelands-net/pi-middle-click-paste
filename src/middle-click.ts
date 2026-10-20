/**
 * Middle-click detection on the raw stdin stream.
 *
 * Pi consumes mouse sequences inside its own input pipeline, so an extension
 * listener never sees them. Observing the stdin bytes directly is read-only and
 * keeps working whatever Pi does with the event afterwards.
 */

import { isMiddleClick, MouseInputScanner, type MouseInputEvent } from "./mouse-input.ts";

/** The part of a stdin stream this module needs. */
export interface MouseInputStream {
  on(event: "data", listener: (chunk: string | Buffer) => void): void;
  removeListener(event: "data", listener: (chunk: string | Buffer) => void): void;
}

export interface MiddleClickWatchOptions {
  onMiddleClick: (event: MouseInputEvent) => void;
  /** Defaults to `process.stdin`; injectable for tests. */
  stdin?: MouseInputStream | undefined;
}

/**
 * Watch stdin for middle-button presses. Returns an idempotent dispose function.
 * The stream itself is never resumed, paused, or re-encoded.
 */
export function watchMiddleClick(options: MiddleClickWatchOptions): () => void {
  const stdin: MouseInputStream = options.stdin ?? process.stdin;
  const scanner = new MouseInputScanner();

  const onData = (chunk: string | Buffer): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const event of scanner.push(text)) {
      if (isMiddleClick(event)) options.onMiddleClick(event);
    }
  };

  stdin.on("data", onData);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    stdin.removeListener("data", onData);
    scanner.reset();
  };
}
