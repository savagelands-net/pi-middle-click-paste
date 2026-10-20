import { describe, expect, it } from "vitest";

import {
  NO_BACKEND_ERROR,
  PrimaryClipboard,
  readCandidates,
  writeCandidates,
  type ClipboardEnvironment,
  type CommandResult,
  type CommandRunner,
} from "../src/primary-clipboard.ts";

const wayland: ClipboardEnvironment = { WAYLAND_DISPLAY: "wayland-1" };
const x11: ClipboardEnvironment = { DISPLAY: ":1" };
const both: ClipboardEnvironment = { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1" };

function labels(candidates: { command: string; args: string[] }[]): string[] {
  return candidates.map((candidate) => `${candidate.command} ${candidate.args.join(" ")}`);
}

interface Recorded {
  command: string;
  args: string[];
  input: string | undefined;
}

/** Scripted command runner: results are keyed by executable name. */
function scripted(
  results: Record<string, CommandResult>,
  recorded: Recorded[] = [],
): { recorded: Recorded[]; runner: CommandRunner } {
  const runner: CommandRunner = async (command, args, input) => {
    recorded.push({ command, args, input });
    return results[command] ?? { ok: true, stdout: "scripted text" };
  };
  return { recorded, runner };
}

describe("candidate selection", () => {
  it("prefers wl-clipboard on Wayland and falls back to X11 tools", () => {
    expect(labels(readCandidates(wayland, "linux"))).toEqual(["wl-paste --primary --no-newline"]);
    expect(labels(readCandidates(both, "linux"))).toEqual([
      "wl-paste --primary --no-newline",
      "xclip -selection primary -out",
      "xsel --primary --output",
    ]);
    expect(labels(readCandidates(x11, "linux"))).toEqual([
      "xclip -selection primary -out",
      "xsel --primary --output",
    ]);
    expect(labels(writeCandidates(wayland, "linux"))).toEqual(["wl-copy --primary"]);
    expect(labels(writeCandidates(both, "linux"))).toEqual([
      "wl-copy --primary",
      "xclip -selection primary",
      "xsel --primary --input",
    ]);
  });

  it("offers nothing without a desktop session or on another platform", () => {
    expect(readCandidates({}, "linux")).toEqual([]);
    expect(writeCandidates({}, "linux")).toEqual([]);
    expect(readCandidates(both, "darwin")).toEqual([]);
    expect(writeCandidates(both, "win32")).toEqual([]);
  });
});

describe("PrimaryClipboard.read", () => {
  it("returns the primary selection and the backend that served it", async () => {
    const { recorded, runner } = scripted({ "wl-paste": { ok: true, stdout: "from another app" } });
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux", runner });

    await expect(clipboard.read()).resolves.toEqual({
      status: "text",
      text: "from another app",
      backend: "wl-paste --primary --no-newline",
    });
    expect(recorded).toEqual([{ command: "wl-paste", args: ["--primary", "--no-newline"], input: undefined }]);
  });

  it("reports an empty selection as empty rather than as text", async () => {
    const { runner } = scripted({ "wl-paste": { ok: true, stdout: "" } });
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux", runner });

    await expect(clipboard.read()).resolves.toEqual({
      status: "empty",
      backend: "wl-paste --primary --no-newline",
    });
  });

  it("tries the next backend when one fails", async () => {
    const { recorded, runner } = scripted({
      "wl-paste": { ok: false, stdout: "" },
      xclip: { ok: true, stdout: "via x11" },
    });
    const clipboard = new PrimaryClipboard({ env: both, platform: "linux", runner });

    await expect(clipboard.read()).resolves.toMatchObject({ status: "text", text: "via x11" });
    expect(recorded.map((call) => call.command)).toEqual(["wl-paste", "xclip"]);
  });

  it("stops retrying a backend that already failed", async () => {
    const { recorded, runner } = scripted({
      "wl-paste": { ok: false, stdout: "" },
      xclip: { ok: true, stdout: "via x11" },
    });
    const clipboard = new PrimaryClipboard({ env: both, platform: "linux", runner });

    await clipboard.read();
    recorded.length = 0;
    await clipboard.read();

    expect(recorded.map((call) => call.command)).toEqual(["xclip"]);
  });

  it("reports no backend when nothing is available", async () => {
    const { runner } = scripted({});
    const clipboard = new PrimaryClipboard({ env: {}, platform: "linux", runner });

    await expect(clipboard.read()).resolves.toEqual({ status: "unavailable", error: NO_BACKEND_ERROR });
    expect(clipboard.available()).toBe(false);
  });

  it("reports no backend when every backend fails", async () => {
    const { runner } = scripted({ "wl-paste": { ok: false, stdout: "" } });
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux", runner });

    await expect(clipboard.read()).resolves.toEqual({ status: "unavailable", error: NO_BACKEND_ERROR });
  });
});

describe("PrimaryClipboard.write", () => {
  it("hands the text to the first backend", async () => {
    const { recorded, runner } = scripted({});
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux", runner });

    await expect(clipboard.write("selected in pi")).resolves.toEqual({
      status: "written",
      backend: "wl-copy --primary",
    });
    expect(recorded).toEqual([{ command: "wl-copy", args: ["--primary"], input: "selected in pi" }]);
  });

  it("falls back to the X11 tools on an X11-only session", async () => {
    const { recorded, runner } = scripted({ xclip: { ok: true, stdout: "" } });
    const clipboard = new PrimaryClipboard({ env: x11, platform: "linux", runner });

    await expect(clipboard.write("text")).resolves.toMatchObject({ backend: "xclip -selection primary" });
    expect(recorded[0]?.command).toBe("xclip");
  });

  it("never publishes an empty selection", async () => {
    const { recorded, runner } = scripted({});
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux", runner });

    await expect(clipboard.write("")).resolves.toEqual({ status: "skipped", reason: "nothing was selected" });
    expect(recorded).toEqual([]);
  });

  it("reports failure when no backend accepts the text", async () => {
    const { runner } = scripted({ "wl-copy": { ok: false, stdout: "" } });
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux", runner });

    await expect(clipboard.write("text")).resolves.toEqual({ status: "unavailable", error: NO_BACKEND_ERROR });
  });
});

describe("PrimaryClipboard.describe", () => {
  it("names the preferred commands without probing", () => {
    const { runner } = scripted({});
    const clipboard = new PrimaryClipboard({ env: both, platform: "linux", runner });

    expect(clipboard.describe()).toEqual({
      paste: "wl-paste --primary --no-newline",
      copy: "wl-copy --primary",
    });
  });

  it("is undefined when no backend can be used", () => {
    const { runner } = scripted({});
    expect(new PrimaryClipboard({ env: {}, platform: "linux", runner }).describe()).toBeUndefined();
  });

  it("uses the real environment by default", () => {
    const clipboard = new PrimaryClipboard({ env: wayland, platform: "linux" });
    expect(clipboard.available()).toBe(true);
    expect(clipboard.describe()?.copy).toBe("wl-copy --primary");
  });
});
