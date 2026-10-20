/**
 * Primary-selection access on Linux.
 *
 * The primary selection is what middle-click pastes on X11 and Wayland. Pi owns
 * the regular clipboard; this module only ever touches the primary selection, and
 * it does so through the desktop clipboard tools so ownership outlives the call.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ClipboardCommand {
  command: string;
  args: string[];
}

export type ClipboardEnvironment = Record<string, string | undefined>;

export interface CommandResult {
  ok: boolean;
  stdout: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
) => Promise<CommandResult>;

export type PrimaryRead =
  | { status: "text"; text: string; backend: string }
  | { status: "empty"; backend: string }
  | { status: "unavailable"; error: string };

export type PrimaryWrite =
  | { status: "written"; backend: string }
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; error: string };

export const NO_BACKEND_ERROR =
  "no primary-selection tool found: install `wl-clipboard` (`wl-copy`/`wl-paste`) on Wayland or `xclip`/`xsel` on X11";

const DEFAULT_TIMEOUT_MS = 1500;

function label(command: ClipboardCommand): string {
  return `${command.command} ${command.args.join(" ")}`;
}

/** Commands that read the primary selection, best match for the session first. */
export function readCandidates(
  env: ClipboardEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): ClipboardCommand[] {
  if (platform !== "linux") return [];
  const candidates: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY) {
    candidates.push({ command: "wl-paste", args: ["--primary", "--no-newline"] });
  }
  if (env.DISPLAY) {
    candidates.push({ command: "xclip", args: ["-selection", "primary", "-out"] });
    candidates.push({ command: "xsel", args: ["--primary", "--output"] });
  }
  return candidates;
}

/** Commands that own the primary selection, best match for the session first. */
export function writeCandidates(
  env: ClipboardEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): ClipboardCommand[] {
  if (platform !== "linux") return [];
  const candidates: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY) {
    candidates.push({ command: "wl-copy", args: ["--primary"] });
  }
  if (env.DISPLAY) {
    // Both tools fork and keep serving the selection after this process exits.
    candidates.push({ command: "xclip", args: ["-selection", "primary"] });
    candidates.push({ command: "xsel", args: ["--primary", "--input"] });
  }
  return candidates;
}

/**
 * Run a clipboard tool.
 *
 * Readers are waited on with their stdout attached. Writers are detached and
 * resolved on process exit instead of stdio close: `wl-copy`, `xclip`, and `xsel`
 * fork a background owner that inherits the child's descriptors, so waiting for
 * the streams to close would hang until the timeout and leak a live descriptor
 * into this process on every copy.
 */
export const runCommand: CommandRunner = (command, args, input, timeoutMs) =>
  input === undefined
    ? runReader(command, args, timeoutMs)
    : runWriter(command, args, input, timeoutMs);

function runReader(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // A killed reader can still hold the text it already printed.
      finish(stdout.length > 0);
    }, timeoutMs);
    timer.unref();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdout?.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function runWriter(
  command: string,
  args: string[],
  text: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      // Own process group, so a Ctrl-C in the terminal does not kill the tool that
      // just took ownership of the selection.
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], detached: true });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.destroy();
      child.unref();
      resolve({ ok, stdout: "" });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timer.unref();

    child.stdin?.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("exit", (code, signal) => finish(signal === null && code === 0));
    child.stdin?.end(text);
  });
}

/** Primary-selection access, as provided by `PrimaryClipboard`. */
export interface PrimarySelection {
  available(): boolean;
  describe(): { paste: string; copy: string } | undefined;
  read(): Promise<PrimaryRead>;
  write(text: string): Promise<PrimaryWrite>;
}

export interface PrimaryClipboardOptions {
  env?: ClipboardEnvironment;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  timeoutMs?: number;
}

/** Reads and writes the primary selection, falling back across available tools. */
export class PrimaryClipboard implements PrimarySelection {
  private readonly env: ClipboardEnvironment;
  private readonly platform: NodeJS.Platform;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  /** Backends that already failed, so a broken tool is not retried on every click. */
  private readonly failed = new Set<string>();

  constructor(options: PrimaryClipboardOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? runCommand;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  available(): boolean {
    return readCandidates(this.env, this.platform).length > 0;
  }

  /** Preferred commands for status output, without probing. */
  describe(): { paste: string; copy: string } | undefined {
    const read = readCandidates(this.env, this.platform)[0];
    const write = writeCandidates(this.env, this.platform)[0];
    if (!read || !write) return undefined;
    return { paste: label(read), copy: label(write) };
  }

  async read(): Promise<PrimaryRead> {
    const candidates = readCandidates(this.env, this.platform);
    if (candidates.length === 0) return { status: "unavailable", error: NO_BACKEND_ERROR };

    for (const candidate of this.order(candidates)) {
      const name = label(candidate);
      const result = await this.runner(candidate.command, candidate.args, undefined, this.timeoutMs);
      if (!result.ok) {
        this.failed.add(name);
        continue;
      }
      const text = result.stdout;
      return text.length === 0
        ? { status: "empty", backend: name }
        : { status: "text", text, backend: name };
    }
    return { status: "unavailable", error: NO_BACKEND_ERROR };
  }

  async write(text: string): Promise<PrimaryWrite> {
    if (text.length === 0) {
      return { status: "skipped", reason: "nothing was selected" };
    }
    const candidates = writeCandidates(this.env, this.platform);
    if (candidates.length === 0) return { status: "unavailable", error: NO_BACKEND_ERROR };

    for (const candidate of this.order(candidates)) {
      const name = label(candidate);
      const result = await this.runner(
        candidate.command,
        candidate.args,
        text,
        // Handing over the text and forking the selection owner needs more time
        // than a read, and a slow failure here must not stall the UI.
        Math.max(this.timeoutMs, 2000),
      );
      if (result.ok) return { status: "written", backend: name };
      this.failed.add(name);
    }
    return { status: "unavailable", error: NO_BACKEND_ERROR };
  }

  /** Failed backends last, so one bad tool does not slow down every click. */
  private order(candidates: ClipboardCommand[]): ClipboardCommand[] {
    const healthy = candidates.filter((candidate) => !this.failed.has(label(candidate)));
    return healthy.length > 0 ? healthy : candidates;
  }
}
