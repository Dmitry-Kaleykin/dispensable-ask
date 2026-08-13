import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dispensableAsk from "./index";

interface Harness {
   api: ExtensionAPI;
   activeTools: () => string[];
   command: (args: string, ctx: ExtensionContext) => Promise<void>;
   sessionStart: (ctx: ExtensionContext) => Promise<void>;
   shortcut: (ctx: ExtensionContext) => Promise<void>;
   tool: any;
   toolCall: (enabled: boolean) => unknown;
}

async function createHarness(): Promise<Harness> {
   let activeTools = ["read"];
   let tool: any;
   let shortcutHandler: ((ctx: ExtensionContext) => Promise<void> | void) | undefined;
   let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
   const eventHandlers = new Map<string, Function[]>();

   const api = {
      registerTool(definition: any) {
         tool = definition;
         activeTools.push(definition.name);
      },
      registerShortcut(_shortcut: string, options: any) {
         shortcutHandler = options.handler;
      },
      registerCommand(_name: string, options: any) {
         commandHandler = options.handler;
      },
      on(name: string, handler: Function) {
         eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) {
         activeTools = [...names];
      },
      events: { emit: vi.fn(), on: vi.fn() },
   } as unknown as ExtensionAPI;

   await dispensableAsk(api);

   return {
      api,
      activeTools: () => [...activeTools],
      command: async (args, ctx) => {
         await commandHandler?.(args, ctx);
      },
      sessionStart: async (ctx) => {
         for (const handler of eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      },
      shortcut: async (ctx) => {
         await shortcutHandler?.(ctx);
      },
      tool,
      toolCall: (isEnabled) => {
         if (isEnabled !== activeTools.includes("ask_user")) throw new Error("Harness state mismatch");
         return eventHandlers.get("tool_call")?.[0]?.({ toolName: "ask_user" }, {});
      },
   };
}

function createContext(
   input?: ExtensionContext["ui"]["input"],
   onTerminalInput?: ExtensionContext["ui"]["onTerminalInput"],
): ExtensionContext {
   return {
      mode: "tui",
      hasUI: true,
      ui: {
         setStatus: vi.fn(),
         notify: vi.fn(),
         input: input ?? vi.fn(),
         onTerminalInput: onTerminalInput ?? vi.fn(() => () => {}),
      },
   } as unknown as ExtensionContext;
}

describe("ask_user lifecycle", () => {
   let agentDirectory: string;

   beforeEach(async () => {
      agentDirectory = await mkdtemp(join(tmpdir(), "dispensable-ask-agent-"));
      process.env.PI_CODING_AGENT_DIR = agentDirectory;
   });

   afterEach(() => {
      vi.useRealTimers();
      delete process.env.PI_CODING_AGENT_DIR;
   });

   it("starts disabled and toggles without disturbing other tools", async () => {
      const harness = await createHarness();
      const ctx = createContext();

      await harness.sessionStart(ctx);
      expect(harness.activeTools()).toEqual(["read"]);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:off");
      expect(harness.toolCall(false)).toMatchObject({ block: true });

      await harness.shortcut(ctx);
      expect(harness.activeTools()).toEqual(["read", "ask_user"]);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:on");
      expect(harness.toolCall(true)).toBeUndefined();

      await harness.shortcut(ctx);
      expect(harness.activeTools()).toEqual(["read"]);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:off");
   });

   it("keeps global and UI preferences out of the model-controlled schema", async () => {
      const harness = await createHarness();
      expect(harness.tool.name).toBe("ask_user");
      expect(harness.tool.parameters.properties).not.toHaveProperty("timeout");
      expect(harness.tool.parameters.properties).not.toHaveProperty("displayMode");
      expect(harness.tool.parameters.properties).not.toHaveProperty("singleSelectLayout");
      expect(harness.tool.parameters.properties).not.toHaveProperty("overlayToggleKey");
      expect(harness.tool.parameters.properties).not.toHaveProperty("commentToggleKey");
   });

   it("instructs the model to honor explicit test requests with a tool call", async () => {
      const harness = await createHarness();
      const instructions = [
         harness.tool.description,
         harness.tool.promptSnippet,
         ...harness.tool.promptGuidelines,
      ].join("\n");

      expect(instructions).toContain("explicitly asks");
      expect(instructions).toContain("call ask_user immediately");
      expect(instructions).toContain("ordinary assistant prose");
   });

   it("auto-disables after the configured period of inactivity", async () => {
      vi.useFakeTimers();
      await writeFile(
         join(agentDirectory, "dispensable-ask.json"),
         JSON.stringify({ timeoutSeconds: 1, shortcut: "alt+a" }),
         "utf8",
      );
      const harness = await createHarness();
      const input = vi.fn((_prompt, _placeholder, options) =>
         new Promise<undefined>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
         })
      );
      const ctx = createContext(input as ExtensionContext["ui"]["input"]);

      await harness.sessionStart(ctx);
      await harness.shortcut(ctx);
      const resultPromise = harness.tool.execute(
         "call-1",
         { question: "Which direction?" },
         new AbortController().signal,
         undefined,
         ctx,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.details).toMatchObject({ timedOut: true, cancelled: true });
      expect(result.content[0].text).toContain("disabled for this session");
      expect(harness.activeTools()).toEqual(["read"]);
   });

   it("restarts the idle timeout when the user types", async () => {
      vi.useFakeTimers();
      await writeFile(
         join(agentDirectory, "dispensable-ask.json"),
         JSON.stringify({ timeoutSeconds: 2, shortcut: "alt+a" }),
         "utf8",
      );
      const harness = await createHarness();
      let terminalInput: ((data: string) => unknown) | undefined;
      const input = vi.fn((_prompt, _placeholder, options) =>
         new Promise<undefined>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
         })
      );
      const ctx = createContext(
         input as ExtensionContext["ui"]["input"],
         ((handler: (data: string) => unknown) => {
            terminalInput = handler;
            return () => {};
         }) as ExtensionContext["ui"]["onTerminalInput"],
      );

      await harness.sessionStart(ctx);
      await harness.shortcut(ctx);
      let settled = false;
      const resultPromise = harness.tool.execute(
         "call-2",
         { question: "What should I use?" },
         new AbortController().signal,
         undefined,
         ctx,
      ).then((result: unknown) => {
         settled = true;
         return result;
      });

      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:on · 2s");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:on · 1s");
      terminalInput?.("x");
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:on · 2s");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise as any;
      expect(result.details).toMatchObject({ timedOut: true });
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "ask:off");
   });
});
