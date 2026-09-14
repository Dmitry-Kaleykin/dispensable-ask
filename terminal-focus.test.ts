import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusTerminal, shouldFocusTerminal } from "./src/ask-user/terminal-focus";

const runFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
   const { promisify } = await import("node:util");
   return { execFile: Object.assign(vi.fn(), { [promisify.custom]: runFile }) };
});

describe("Terminal activation", () => {
   const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
   const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

   beforeEach(() => {
      runFile.mockReset();
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
      for (const key of ["SSH_CONNECTION", "SSH_TTY", "TMUX", "STY", "DISPENSABLE_ASK_FOCUS_TERMINAL"]) {
         vi.stubEnv(key, undefined);
      }
   });

   afterEach(() => {
      Object.defineProperty(process, "platform", platform);
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      vi.unstubAllEnvs();
   });

   it("only enables activation in a local Apple Terminal TTY on macOS", () => {
      expect(shouldFocusTerminal()).toBe(true);
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(shouldFocusTerminal()).toBe(false);
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process.stdin, "isTTY", { value: false });
      expect(shouldFocusTerminal()).toBe(false);
   });

   it.each([
      ["TERM_PROGRAM", "iTerm.app"], ["SSH_CONNECTION", "host"],
      ["SSH_TTY", "/dev/ttys001"], ["TMUX", "session"], ["STY", "session"],
      ["DISPENSABLE_ASK_FOCUS_TERMINAL", "false"],
   ])("skips activation with %s=%s", (key, value) => {
      vi.stubEnv(key, value);
      expect(shouldFocusTerminal()).toBe(false);
   });

   it("passes the current process's TTY as data to a bounded AppleScript call", async () => {
      runFile.mockResolvedValueOnce({ stdout: "ttys003\n" }).mockResolvedValueOnce({ stdout: "" });
      const signal = new AbortController().signal;
      await focusTerminal(signal);
      expect(runFile.mock.calls[0]).toEqual([
         "/bin/ps", ["-o", "tty=", "-p", String(process.pid)],
         expect.objectContaining({ timeout: 1_000, signal }),
      ]);
      expect(runFile.mock.calls[1]).toEqual([
         "/usr/bin/osascript", ["-e", expect.any(String), "/dev/ttys003"],
         expect.objectContaining({ timeout: 3_000, signal }),
      ]);
   });

   it.each(["??", "", "ttys001; injected"])("does not activate for an invalid TTY: %s", async (stdout) => {
      runFile.mockResolvedValue({ stdout });
      await focusTerminal();
      expect(runFile).toHaveBeenCalledOnce();
   });

   it("ignores process lookup and Automation failures", async () => {
      runFile.mockRejectedValueOnce(new Error("ps unavailable"));
      await expect(focusTerminal()).resolves.toBeUndefined();
      runFile.mockResolvedValueOnce({ stdout: "ttys001" }).mockRejectedValueOnce(new Error("Automation denied"));
      await expect(focusTerminal()).resolves.toBeUndefined();
   });

   it("stops when cancelled before or during TTY lookup", async () => {
      await focusTerminal(AbortSignal.abort());
      expect(runFile).not.toHaveBeenCalled();
      const controller = new AbortController();
      runFile.mockImplementationOnce(async () => {
         controller.abort();
         return { stdout: "ttys001" };
      });
      await focusTerminal(controller.signal);
      expect(runFile).toHaveBeenCalledOnce();
   });
});
