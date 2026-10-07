import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dispensableAsk from "./index";
import { focusTerminal, shouldFocusTerminal } from "./src/ask-user/terminal-focus";
import type { BatchAskComponent } from "./src/ask-user/ui/batch-ask-component";

vi.mock("./src/ask-user/terminal-focus", () => ({
   focusTerminal: vi.fn(async () => {}),
   shouldFocusTerminal: vi.fn(() => false),
}));

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
         select: vi.fn(async (_prompt: string, options: string[]) => options.includes("Submit all answers") ? "Submit all answers" : undefined),
         custom: vi.fn(async () => undefined),
         onTerminalInput: onTerminalInput ?? vi.fn(() => () => {}),
      },
   } as unknown as ExtensionContext;
}

describe("ask_user lifecycle", () => {
   let agentDirectory: string;

   beforeEach(async () => {
      vi.mocked(shouldFocusTerminal).mockReset().mockReturnValue(false);
      vi.mocked(focusTerminal).mockReset().mockResolvedValue(undefined);
      agentDirectory = await mkdtemp(join(tmpdir(), "dispensable-ask-agent-"));
      process.env.PI_CODING_AGENT_DIR = agentDirectory;
   });

   afterEach(() => {
      vi.useRealTimers();
      delete process.env.PI_CODING_AGENT_DIR;
   });

   it("starts with the timer disabled and keeps the tool available when toggling", async () => {
      const harness = await createHarness();
      const ctx = createContext();

      await harness.sessionStart(ctx);
      expect(harness.activeTools()).toEqual(["read", "ask_user"]);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:off");
      expect(harness.toolCall(true)).toBeUndefined();

      await harness.shortcut(ctx);
      expect(harness.activeTools()).toEqual(["read", "ask_user"]);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on");
      expect(harness.toolCall(true)).toBeUndefined();

      await harness.shortcut(ctx);
      expect(harness.activeTools()).toEqual(["read", "ask_user"]);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:off");
   });

   it("commands control the timer and session start resets it", async () => {
      const harness = await createHarness();
      const ctx = createContext();
      for (const command of ["on", "enable", "off", "disable", "toggle"]) {
         await harness.command(command, ctx);
         expect(harness.activeTools()).toEqual(["read", "ask_user"]);
         expect(harness.toolCall(true)).toBeUndefined();
      }
      await harness.sessionStart(ctx);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:off");
      await harness.command("status", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("disabled (waits indefinitely)"), "info");
   });

   it.each(["freeform", "rpc", "custom"])("waits indefinitely with the timer off in %s questions", async (kind) => {
      vi.useFakeTimers();
      const harness = await createHarness();
      let answer!: (value: any) => void;
      const dialog = vi.fn((_prompt, _placeholder, options) => _prompt.startsWith("Review answers") ? Promise.resolve("Submit all answers") : new Promise((resolve) => {
         answer = resolve;
         options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }));
      const ctx = createContext(dialog as any);
      ctx.ui.select = dialog as any;
      ctx.ui.custom = kind === "custom"
         ? vi.fn((factory: any) => new Promise((resolve) => {
            answer = resolve;
            factory(
               { terminal: { rows: 24 }, requestRender: vi.fn() },
               { fg: (_color: string, text: string) => text, bold: (text: string) => text },
               getKeybindings(),
               resolve,
            );
         })) as any
         : vi.fn(async () => undefined) as any;
      await harness.sessionStart(ctx);
      // Exercise explicit off as well as the session default.
      await harness.command("on", ctx);
      await harness.command("off", ctx);
      let settled = false;
      const pending = harness.tool.execute("untimed", {
         questions: [{ question: "Which direction?", options: kind === "freeform" ? [] : [{ title: "Yes" }] }],
      }, undefined, undefined, ctx).then((result: any) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1_000);
      expect(settled).toBe(false);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:off");
      await harness.shortcut(ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("timer state was not changed"), "warning");
      answer(kind === "custom" ? { answers: [{ index: 1, question: "Which direction?", response: { kind: "selection", selections: ["Yes"] } }] } : kind === "freeform" ? "Yes" : "1. Yes");
      const result = await pending;
      expect(result.details.cancelled).toBe(false);
      expect(result.details.timedOut).toBeUndefined();
      expect(result.content[0].text).toContain("Yes");
      expect(vi.getTimerCount()).toBe(0);
   });

   it.each(["cancel", "abort"])("supports %s with the timer disabled", async (action) => {
      vi.useFakeTimers();
      let cancel!: () => void;
      const input = vi.fn((_prompt, _placeholder, options) => new Promise<undefined>((resolve) => {
         cancel = () => resolve(undefined);
         options.signal.addEventListener("abort", cancel, { once: true });
      }));
      const harness = await createHarness();
      const ctx = createContext(input as any);
      const controller = new AbortController();
      await harness.sessionStart(ctx);
      const pending = harness.tool.execute("untimed", { questions: [{ question: "Proceed?" }] }, controller.signal, undefined, ctx);
      await vi.advanceTimersByTimeAsync(0);
      if (action === "cancel") cancel();
      else controller.abort();
      const result = await pending;
      expect(result.details.cancelled).toBe(true);
      expect(result.details.timedOut).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      await harness.command("on", ctx);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on");
   });

   it.each(["rpc", "custom"])("times out option questions with the timer enabled in %s", async (kind) => {
      vi.useFakeTimers();
      const harness = await createHarness();
      const ctx = createContext();
      ctx.ui.select = vi.fn((_prompt, _options, dialogOptions) => new Promise((resolve) => {
         dialogOptions.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      })) as any;
      ctx.ui.custom = kind === "custom"
         ? vi.fn((factory: any) => new Promise((resolve) => {
            factory(
               { terminal: { rows: 24 }, requestRender: vi.fn() },
               { fg: (_color: string, text: string) => text, bold: (text: string) => text },
               getKeybindings(),
               resolve,
            );
         })) as any
         : vi.fn(async () => undefined) as any;
      await harness.sessionStart(ctx);
      await harness.command("on", ctx);
      const pending = harness.tool.execute("timed", {
         questions: [{ question: "Which direction?", options: [{ title: "Yes" }] }],
      }, undefined, undefined, ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.details).toMatchObject({ timedOut: true, cancelled: true });
      expect(harness.activeTools()).toContain("ask_user");
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on");
      expect(vi.getTimerCount()).toBe(0);
   });

   it("keeps global and UI preferences out of the model-controlled schema", async () => {
      const harness = await createHarness();
      expect(harness.tool.name).toBe("ask_user");
      expect(harness.tool.parameters.required).toEqual(["questions"]);
      expect(harness.tool.parameters.properties).not.toHaveProperty("question");
      expect(harness.tool.parameters.properties).not.toHaveProperty("timeout");
      expect(harness.tool.parameters.properties).not.toHaveProperty("displayMode");
      expect(harness.tool.parameters.properties).not.toHaveProperty("singleSelectLayout");
      expect(harness.tool.parameters.properties).not.toHaveProperty("overlayToggleKey");
      expect(harness.tool.parameters.properties).not.toHaveProperty("commentToggleKey");
   });

   it.each([
      { question: "Legacy shape?" },
      { questions: [] },
      { questions: [{ question: "Valid?" }, { question: "Impossible?", allowFreeform: false }] },
      { questions: [{ question: "Valid?" }, { question: "Invalid?", options: [{}] }] },
   ])("rejects malformed batches before any question opens: %j", async (params) => {
      const harness = await createHarness();
      const ctx = createContext();
      vi.mocked(shouldFocusTerminal).mockReturnValue(true);
      const result = await harness.tool.execute("invalid", params, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(ctx.ui.input).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(focusTerminal).not.toHaveBeenCalled();
   });

   it.each(["submit", "cancel", "abort", "timeout"])("handles %s at review without releasing partial answers", async (action) => {
      vi.useFakeTimers();
      const harness = await createHarness();
      const ctx = createContext();
      let component!: BatchAskComponent;
      ctx.ui.custom = vi.fn((factory: any) => new Promise((resolve) => {
         component = factory(
            { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            getKeybindings(), resolve,
         );
      })) as any;
      const controller = new AbortController();
      const onUpdate = vi.fn();
      await harness.command("on", ctx);
      const pending = harness.tool.execute("batch", { questions: [
         { question: "First?", options: [{ title: "A" }] },
         { question: "Second?", options: [{ title: "B" }] },
      ] }, controller.signal, onUpdate, ctx);
      component.handleInput("\r");
      component.handleInput("\r");
      expect(component.render(100).join("\n")).toContain("Review answers (2/2 answered)");
      expect(onUpdate).toHaveBeenCalledOnce();
      expect(onUpdate.mock.calls[0][0].details.answers).toBeNull();
      expect(harness.api.events.emit).not.toHaveBeenCalledWith("ask:answered", expect.anything());
      if (action === "submit") component.handleInput("\r");
      else if (action === "cancel") component.handleInput("\x1b");
      else if (action === "abort") controller.abort();
      else {
         await vi.advanceTimersByTimeAsync(29_000);
         component.handleInput("\x10"); // Navigate back: activity restarts the idle timer.
         await vi.advanceTimersByTimeAsync(29_000);
         component.handleInput("\x0e");
         await vi.advanceTimersByTimeAsync(30_000);
      }
      const result = await pending;
      if (action === "submit") {
         expect(result.details.answers.map((answer: any) => answer.index)).toEqual([1, 2]);
         expect(JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf("{"))).answers).toEqual(result.details.answers);
         expect(harness.api.events.emit).toHaveBeenCalledWith("ask:answered", { questions: result.details.questions, answers: result.details.answers });
      } else {
         expect(result.details).toMatchObject({ answers: null, cancelled: true });
         expect(harness.api.events.emit).not.toHaveBeenCalledWith("ask:answered", expect.anything());
      }
      expect(result.details.timedOut).toBe(action === "timeout" ? true : undefined);
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.api.events.emit).toHaveBeenLastCalledWith("herdr:blocked", { active: false });
      await harness.command("off", ctx); // activeAsk was released after every exit path.
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:off");
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

   it.each([{ options: [] }, { options: [{ title: "Yes" }] }])("focuses before opening the question and starting its timer ($options)", async ({ options }) => {
      vi.mocked(shouldFocusTerminal).mockReturnValue(true);
      let finishFocus!: () => void;
      vi.mocked(focusTerminal).mockImplementation(() => new Promise((resolve) => { finishFocus = resolve; }));
      const harness = await createHarness();
      const ctx = createContext(vi.fn(async () => "Yes"));
      ctx.ui.custom = vi.fn(async () => null) as any;
      await harness.command("on", ctx);
      const pending = harness.tool.execute("focus", { questions: [{ question: "Proceed?", options }] }, undefined, undefined, ctx);

      expect(focusTerminal).toHaveBeenCalledOnce();
      expect(ctx.ui.input).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on");
      finishFocus();
      await pending;
      expect(ctx.ui.custom).toHaveBeenCalledOnce();
   });

   it("does not focus for malformed, headless, RPC, or aborted calls", async () => {
      vi.mocked(shouldFocusTerminal).mockReturnValue(true);
      const harness = await createHarness();
      const ctx = createContext(vi.fn(async () => "Answer"));
      const call = (params = { questions: [{ question: "Question?" }] }, context = ctx, signal?: AbortSignal) =>
         harness.tool.execute("skip", params, signal, undefined, context);
      await harness.command("on", ctx);
      await call({ questions: [{ question: "Question?", options: [{}] }] } as any);
      await call(undefined, { ...ctx, hasUI: false });
      await call(undefined, { ...ctx, mode: "rpc" });
      await call(undefined, ctx, AbortSignal.abort());
      expect(focusTerminal).not.toHaveBeenCalled();
   });

   it("does not open a question when cancelled during activation", async () => {
      vi.mocked(shouldFocusTerminal).mockReturnValue(true);
      const controller = new AbortController();
      vi.mocked(focusTerminal).mockImplementation(async () => { controller.abort(); });
      const harness = await createHarness();
      const ctx = createContext();
      await harness.command("on", ctx);
      const result = await harness.tool.execute("abort-focus", { questions: [{ question: "Question?" }] }, controller.signal, undefined, ctx);
      expect(result.details.cancelled).toBe(true);
      expect(ctx.ui.input).not.toHaveBeenCalled();
      await harness.command("off", ctx);
      expect(harness.activeTools()).toContain("ask_user");
   });

   it("times out after inactivity and leaves the timer and tool enabled for later questions", async () => {
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
         { questions: [{ question: "Which direction?" }] },
         new AbortController().signal,
         undefined,
         ctx,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.details).toMatchObject({ timedOut: true, cancelled: true });
      expect(result.content[0].text).toContain("Continue using your best judgment");
      expect(result.content[0].text).not.toContain("disabled");
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on");
      const nextQuestion = harness.tool.execute("next", { questions: [{ question: "Another question?" }] }, undefined, undefined, ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await nextQuestion).details.timedOut).toBe(true);
      expect(harness.activeTools()).toEqual(["read", "ask_user"]);
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
         { questions: [{ question: "What should I use?" }] },
         new AbortController().signal,
         undefined,
         ctx,
      ).then((result: unknown) => {
         settled = true;
         return result;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on · 2s");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on · 1s");
      terminalInput?.("x");
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on · 2s");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise as any;
      expect(result.details).toMatchObject({ timedOut: true });
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("dispensable-ask", "❓ ask timer:on");
   });
});
