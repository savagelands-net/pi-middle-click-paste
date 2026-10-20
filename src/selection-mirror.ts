/**
 * Mirror Pi's transcript selection into the primary selection.
 *
 * Pi draws the selection highlight itself and owns the text behind it. The
 * prototype-level hook below mirrors a finished drag into the primary selection
 * without changing what Pi does with it, so copy-on-select, the regular
 * clipboard, and `ctrl+shift+c` keep working exactly as before.
 */

import type { PointerEventLike } from "./pointer-event.ts";
import { isSelectionRelease } from "./pointer-event.ts";

interface SelectionHost {
  getActiveSelectionText?: () => string | undefined;
  handleSelectionMouseEvent?: (this: SelectionHost, event: PointerEventLike) => void;
}

type OriginalHandler = NonNullable<SelectionHost["handleSelectionMouseEvent"]>;

/** Pristine handlers replaced by this module, so `restore()` can put them back. */
const originals = new WeakMap<object, OriginalHandler>();

export interface SelectionMirrorOptions {
  /** Called once per finished selection with the exact selected text. */
  onSelection: (text: string) => void;
  /** Called when mirroring fails, so the host can surface it without breaking Pi. */
  onError?: (error: unknown) => void;
}

export interface SelectionMirrorHandle {
  /** False when this Pi version does not expose the selection internals we need. */
  supported: boolean;
  restore: () => void;
}

/**
 * Patch a TUI prototype so every completed transcript selection is reported via
 * `onSelection`. Idempotent: installing twice keeps a single wrapper.
 */
export function mirrorSelectionOnRelease(
  prototype: unknown,
  options: SelectionMirrorOptions,
): SelectionMirrorHandle {
  const host = prototype as SelectionHost;
  const original = originals.get(host) ?? host.handleSelectionMouseEvent;
  if (typeof original !== "function" || typeof host.getActiveSelectionText !== "function") {
    return { supported: false, restore: () => undefined };
  }

  const wrapped = function (this: SelectionHost, event: PointerEventLike): void {
    original.call(this, event);
    if (!isSelectionRelease(event)) return;
    try {
      const text = this.getActiveSelectionText?.();
      if (text) options.onSelection(text);
    } catch (error) {
      options.onError?.(error);
    }
  };

  originals.set(host, original);
  host.handleSelectionMouseEvent = wrapped;

  return {
    supported: true,
    restore: () => {
      // Never clobber a handler installed after ours.
      if (host.handleSelectionMouseEvent !== wrapped) return;
      host.handleSelectionMouseEvent = original;
      originals.delete(host);
    },
  };
}
