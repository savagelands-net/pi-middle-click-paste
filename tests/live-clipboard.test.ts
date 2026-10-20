import { describe, expect, it } from "vitest";

import { PrimaryClipboard, type PrimaryRead } from "../src/primary-clipboard.ts";

/**
 * Opt-in check against the real desktop primary selection:
 *
 *   PI_MIDDLE_CLICK_PASTE_LIVE=1 npx vitest run
 *
 * It temporarily takes over the primary selection and restores it afterwards.
 */
const live = process.env.PI_MIDDLE_CLICK_PASTE_LIVE === "1";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithRetry(clipboard: PrimaryClipboard, attempts = 20): Promise<string> {
  // The clipboard owner publishes its offer asynchronously.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read: PrimaryRead = await clipboard.read();
    if (read.status === "text") return read.text;
    if (read.status === "unavailable") return "";
    await delay(25);
  }
  return "";
}

describe.skipIf(!live)("primary selection on this desktop", () => {
  it("round-trips text through the real primary selection", async () => {
    const clipboard = new PrimaryClipboard();
    const backends = clipboard.describe();
    expect(backends, "no clipboard tool detected on this session").toBeDefined();

    const previous = await clipboard.read();
    const marker = `pi-middle-click-paste ${process.hrtime.bigint()}`;
    try {
      const startedAt = Date.now();
      const written = await clipboard.write(marker);
      const elapsedMs = Date.now() - startedAt;

      expect(written.status).toBe("written");
      // The tool forks a background owner: handing over the text must not wait for it.
      expect(elapsedMs, "write waited for the clipboard owner to exit").toBeLessThan(1000);
      expect(await readWithRetry(clipboard)).toBe(marker);
    } finally {
      if (previous.status === "text") await clipboard.write(previous.text);
    }
  }, 20000);
});
