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

function createContext(input?: ExtensionContext["ui"]["input"]): ExtensionContext {
   return {
      mode: "tui",
      hasUI: true,
      ui: {
         setStatus: vi.fn(),
         notify: vi.fn(),
         input: input ?? vi.fn(),
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
      expect(harness.toolCall(false)).toMatchObject({ block: true });

      await harness.shortcut(ctx);
      expect(harness.activeTools()).toEqual(["read", "ask_user"]);
      expect(harness.toolCall(true)).toBeUndefined();

      await harness.shortcut(ctx);
      expect(harness.activeTools()).toEqual(["read"]);
   });

   it("keeps timeout out of the model-controlled schema", async () => {
      const harness = await createHarness();
      expect(harness.tool.name).toBe("ask_user");
      expect(harness.tool.parameters.properties).not.toHaveProperty("timeout");
   });

   it("auto-disables after the global deadline", async () => {
      vi.useFakeTimers();
      await writeFile(
         join(agentDirectory, "dispensable-ask.json"),
         JSON.stringify({ timeoutSeconds: 1, shortcut: "alt+a" }),
         "utf8",
      );
      const harness = await createHarness();
      const input = vi.fn((_prompt, _placeholder, options) =>
         new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.timeout))
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
});
