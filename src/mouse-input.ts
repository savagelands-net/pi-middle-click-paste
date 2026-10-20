/**
 * SGR (xterm 1006) mouse sequence scanning over a raw terminal input stream.
 *
 * Pi enables mouse tracking in fullscreen mode, so pointer events arrive on
 * stdin as escape sequences instead of being handled by the terminal. Sequences
 * can be split across stdin chunks, which is why scanning is stateful.
 */

export type MouseButton = "left" | "middle" | "right" | "none";

export interface MouseInputEvent {
  button: MouseButton;
  /** True for press and motion sequences, false for the matching release (`m`). */
  pressed: boolean;
  /** Zero-based terminal cell coordinates. */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Set when the sequence reports pointer motion (button-code bit 32). */
  motion: boolean;
  /** Set when the sequence reports a wheel turn (button-code bit 64). */
  wheel: boolean;
}

/** Longest tail kept between chunks while waiting for a sequence to complete. */
const MAX_PARTIAL_LENGTH = 32;
/** A tail that can still grow into an SGR mouse sequence. */
const PARTIAL_TAIL = /^\x1b(?:\[<?[\d;]*)?$/;
const SGR_SEQUENCE_SOURCE = "\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])";

function decodeButton(button: number): MouseButton {
  if ((button & 64) !== 0) return "none";
  switch (button & 3) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

function decodeSgr(button: number, x: number, y: number, terminator: string): MouseInputEvent {
  return {
    button: decodeButton(button),
    pressed: terminator === "M",
    x,
    y,
    shift: (button & 4) !== 0,
    alt: (button & 8) !== 0,
    ctrl: (button & 16) !== 0,
    motion: (button & 32) !== 0,
    wheel: (button & 64) !== 0,
  };
}

export class MouseInputScanner {
  private pending = "";
  private readonly pattern = new RegExp(SGR_SEQUENCE_SOURCE, "g");

  /** Scan a stdin chunk, returning every complete mouse event it completes. */
  push(chunk: string): MouseInputEvent[] {
    const input = this.pending.length > 0 ? this.pending + chunk : chunk;
    this.pending = "";

    const events: MouseInputEvent[] = [];
    let consumed = 0;
    let match: RegExpExecArray | null = this.pattern.exec(input);
    while (match !== null) {
      const button = Number.parseInt(match[1] ?? "", 10);
      const x = Number.parseInt(match[2] ?? "", 10) - 1;
      const y = Number.parseInt(match[3] ?? "", 10) - 1;
      if (Number.isFinite(button) && Number.isFinite(x) && Number.isFinite(y)) {
        events.push(decodeSgr(button, x, y, match[4] ?? "M"));
      }
      consumed = this.pattern.lastIndex;
      match = this.pattern.exec(input);
    }

    const tail = input.slice(consumed);
    const escapeStart = tail.lastIndexOf("\x1b");
    if (escapeStart !== -1) {
      const candidate = tail.slice(escapeStart);
      if (candidate.length <= MAX_PARTIAL_LENGTH && PARTIAL_TAIL.test(candidate)) {
        this.pending = candidate;
      }
    }
    return events;
  }

  reset(): void {
    this.pending = "";
  }
}

/**
 * True for the gesture that means "paste the primary selection": a middle-button
 * press that is neither a wheel turn nor pointer motion.
 */
export function isMiddleClick(event: MouseInputEvent): boolean {
  return event.button === "middle" && event.pressed && !event.motion && !event.wheel;
}
