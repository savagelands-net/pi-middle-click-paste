/**
 * Pi's internal mouse-event shape, as built by its SGR parser and passed to
 * `handleSelectionMouseEvent`.
 */
export interface PointerEventLike {
  /** Raw SGR button code: low bits select the button, high bits are modifiers. */
  button: number;
  /** One-based terminal cell coordinates, as they arrive from the parser. */
  x: number;
  y: number;
  /** True for the release terminator (`m`) rather than a press (`M`). */
  release: boolean;
}

/**
 * True for the event that finishes a drag selection. Pi accepts a plain
 * left-button release and the legacy `button === 3` release marker.
 */
export function isSelectionRelease(event: PointerEventLike): boolean {
  if (!event.release) return false;
  // Wheel turns never finish a selection.
  if ((event.button & 64) !== 0) return false;
  const code = event.button & 3;
  return code === 0 || code === 3;
}
