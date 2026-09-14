import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseBooleanPreference } from "./model";

const runFile = promisify(execFile);

// Match the tab by its TTY: activating Terminal alone can select a different
// agent's window or desktop. Pass the TTY as data, never as script source.
const FOCUS_SCRIPT = `
on run argv
   set targetTTY to item 1 of argv
   if application "/System/Applications/Utilities/Terminal.app" is not running then return
   tell application "/System/Applications/Utilities/Terminal.app"
      repeat with terminalWindow in windows
         repeat with terminalTab in tabs of terminalWindow
            if tty of terminalTab is targetTTY then
               set selected tab of terminalWindow to terminalTab
               set miniaturized of terminalWindow to false
               set index of terminalWindow to 1
               activate
               return
            end if
         end repeat
      end repeat
   end tell
end run
`;

export function shouldFocusTerminal(): boolean {
   return process.platform === "darwin"
      && process.stdin.isTTY === true
      && process.env.TERM_PROGRAM === "Apple_Terminal"
      && !process.env.SSH_CONNECTION
      && !process.env.SSH_TTY
      && !process.env.TMUX
      && !process.env.STY
      && (parseBooleanPreference(process.env.DISPENSABLE_ASK_FOCUS_TERMINAL) ?? true);
}

/** Best effort, bounded, and completed before the question's idle clock starts. */
export async function focusTerminal(signal?: AbortSignal): Promise<void> {
   if (signal?.aborted) return;
   try {
      const { stdout } = await runFile("/bin/ps", ["-o", "tty=", "-p", String(process.pid)], {
         encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1_024, signal,
      });
      const tty = stdout.trim();
      if (!/^tty[a-zA-Z0-9]+$/.test(tty) || signal?.aborted) return;
      await runFile("/usr/bin/osascript", ["-e", FOCUS_SCRIPT, `/dev/${tty}`], {
         encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 4_096, signal,
      });
   } catch {
      // Unsupported sessions, denied Automation access, closed windows, and
      // cancellation must never prevent the user from answering the question.
   }
}
