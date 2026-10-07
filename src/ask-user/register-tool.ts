import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type KeybindingsManager, type OverlayHandle, Text, type TUI } from "@earendil-works/pi-tui";
import { formatTimeout } from "../config/config";
import type { AskTimer } from "../extension/ask-timer";
import { MODEL_TOOL_NAME } from "./constants";
import { askBatchViaDialogs } from "./dialogs";
import { IdleTimeout } from "./idle-timeout";
import { focusTerminal, shouldFocusTerminal } from "./terminal-focus";
import {
   type AskBatchResult, type AskDisplayMode, type AskQuestion, type AskResponse,
   type AskSingleSelectLayout, type AskToolDetails, coerceOption,
   formatOptionsForMessage, formatResponseSummary, isSelectionResponse,
   normalizeQuestions, parseBooleanPreference,
} from "./model";
import { BatchAskComponent } from "./ui/batch-ask-component";
import {
   DEFAULT_COMMENT_TOGGLE_KEY, DEFAULT_OVERLAY_TOGGLE_KEY,
   type ResolvedAskShortcuts, buildCustomUIOptions, resolveShortcut,
} from "./ui/shared";

export const DEFAULT_PROMPT_SNIPPET = "Ask the user one or more questions and receive their reviewed answers together";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
   "Use ask_user when you cannot proceed without a concrete user decision. If the user explicitly asks to test this tool, call ask_user immediately instead of asking in ordinary assistant prose.",
   'Always pass a questions array, even for one question: { "questions": [{ "question": "Proceed?" }] }.',
   "Batch only independent questions, usually no more than three; ask dependent follow-up questions in a later call.",
   "Gather available context first and pass a short summary in each question's context field.",
   "Provide options for concrete choices; omit options for an open-ended answer. Use allowMultiple only for selecting multiple options within one question.",
   "Call ask_user on its own turn; do not batch it with other tool calls because it blocks until the user submits the whole batch.",
   "Do not ask for confirmation of a decision the user already made.",
   "On cancellation or timeout, no draft answers are submitted. Continue with your best judgment and do not retry the same questions.",
];

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions and wait for them to review and submit all answers together.
Input: { "questions": [{ "question": "Which direction?", "options": [{ "title": "A", "description": "Optional detail" }] }] }. There is no top-level question field.
- Each question has its own context, options, allowMultiple, allowFreeform, and allowComment settings.
- Omit options for freeform text. Freeform answers are also available alongside options by default.
- The user can navigate between questions and edit previous answers before submitting from a review page. Every question requires an answer.
- Answers include their one-based index in the questions array, question text, and response (selection or freeform).
- Call ask_user on its own, without other tool calls in the same turn. If the user cancels or an enabled inactivity timer expires, continue with your best judgment without retrying the same questions.`;

const QuestionSchema = Type.Object({
   question: Type.String({ minLength: 1, description: "The focused question to ask the user" }),
   context: Type.Optional(Type.String({ description: "Short summary of relevant findings shown with this question" })),
   // Keep option items flat: several providers/proxies strip union item schemas.
   options: Type.Optional(Type.Array(Type.Object({
      title: Type.String({ description: "Short title for this option" }),
      description: Type.Optional(Type.String({ description: "Longer explanation of this option" })),
   }), { description: "Choices for this question; omit for a freeform answer" })),
   allowMultiple: Type.Optional(Type.Boolean({ description: "Select multiple options within this question. Default: false" })),
   allowFreeform: Type.Optional(Type.Boolean({ description: "Allow a freeform answer. Default: true" })),
   allowComment: Type.Optional(Type.Boolean({ description: "Optional comment after a selection. Default: DISPENSABLE_ASK_ALLOW_COMMENT env var, otherwise false" })),
}, { additionalProperties: false });

export function registerAskUserTool(pi: ExtensionAPI, timer: AskTimer): void {
   pi.registerTool({
      name: MODEL_TOOL_NAME,
      label: "Dispensable Ask",
      description: DEFAULT_TOOL_DESCRIPTION,
      promptSnippet: DEFAULT_PROMPT_SNIPPET,
      promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
      executionMode: "sequential",
      parameters: Type.Object({
         questions: Type.Array(QuestionSchema, { minItems: 1, description: "Independent questions to answer and submit together, usually one to three" }),
      }, { additionalProperties: false }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         let questions: AskQuestion[];
         try {
            questions = normalizeQuestions(params.questions, parseBooleanPreference(process.env.DISPENSABLE_ASK_ALLOW_COMMENT) ?? false);
         } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
               content: [{ type: "text" as const, text: message }], isError: true,
               details: { questions: [], answers: null, cancelled: true, error: message } as AskToolDetails,
            };
         }
         const cancelledDetails = (): AskToolDetails => ({ questions, answers: null, cancelled: true });
         if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: cancelledDetails() };

         timer.activeAsk = true;
         let blocked = false;
         let idleTimeout: IdleTimeout | undefined;
         let removeOverlayInputListener: (() => void) | undefined;
         let removeAbortListener: (() => void) | undefined;
         try {
            if (!ctx.hasUI || !ctx.ui) {
               const prompts = questions.map((question, index) => {
                  const context = question.context ? `\nContext:\n${question.context}` : "";
                  const options = question.options.length ? `\nOptions:\n${formatOptionsForMessage(question.options)}` : "";
                  return `${index + 1}. ${question.question}${context}${options}`;
               }).join("\n\n");
               return {
                  content: [{ type: "text" as const, text: `Ask requires interactive mode. Please answer:\n\n${prompts}` }],
                  isError: true, details: cancelledDetails(),
               };
            }
            if (ctx.mode === "tui" && shouldFocusTerminal()) {
               await focusTerminal(signal);
               if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: cancelledDetails() };
            }

            const timeout = timer.enabled ? timer.config.timeoutSeconds * 1000 : undefined;
            let timedOut = false;
            let component: BatchAskComponent | undefined;
            const markTimedOut = () => { timedOut = true; };
            const showCountdown = (remainingSeconds: number) => {
               timer.showCountdown(ctx, remainingSeconds);
               component?.setRemainingIdleSeconds(remainingSeconds);
            };
            const envMode = process.env.DISPENSABLE_ASK_DISPLAY_MODE?.trim().toLowerCase();
            const displayMode: AskDisplayMode = envMode === "inline" ? "inline" : "overlay";
            const singleSelectLayout: AskSingleSelectLayout = process.env.DISPENSABLE_ASK_SINGLE_SELECT_LAYOUT?.trim().toLowerCase() === "list" ? "list" : "auto";
            const shortcuts: ResolvedAskShortcuts = {
               overlayToggle: resolveShortcut(undefined, process.env.DISPENSABLE_ASK_OVERLAY_TOGGLE_KEY, DEFAULT_OVERLAY_TOGGLE_KEY),
               commentToggle: resolveShortcut(undefined, process.env.DISPENSABLE_ASK_COMMENT_TOGGLE_KEY, DEFAULT_COMMENT_TOGGLE_KEY),
            };

            onUpdate?.({ content: [{ type: "text", text: `Waiting for ${questions.length} answer(s) and final submission...` }], details: { questions, answers: null, cancelled: false } });
            pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user responses" });
            blocked = true;
            let overlayHandle: OverlayHandle | undefined;
            let hasAnnouncedHide = false;
            if (displayMode === "overlay" && !shortcuts.overlayToggle.disabled && typeof ctx.ui.onTerminalInput === "function") {
               removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
                  if (!shortcuts.overlayToggle.matches(data) || !overlayHandle) return undefined;
                  idleTimeout?.touch();
                  const hidden = !overlayHandle.isHidden();
                  overlayHandle.setHidden(hidden);
                  if (hidden && !hasAnnouncedHide) {
                     hasAnnouncedHide = true;
                     ctx.ui.notify?.(`ask_user hidden — press ${shortcuts.overlayToggle.spec} to reopen`, "info");
                  }
                  return { consume: true };
               });
            }
            const factory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AskBatchResult | null) => void) => {
               component = new BatchAskComponent(questions, displayMode, singleSelectLayout, tui, theme, keybindings, shortcuts, done, () => idleTimeout?.touch());
               if (timeout !== undefined) {
                  idleTimeout = new IdleTimeout(timeout, () => { markTimedOut(); done(null); }, showCountdown);
                  idleTimeout.start();
               }
               if (signal) {
                  const onAbort = () => done(null);
                  signal.addEventListener("abort", onAbort, { once: true });
                  removeAbortListener = () => signal.removeEventListener("abort", onAbort);
                  if (signal.aborted) onAbort();
               }
               return component;
            };

            let result = typeof ctx.ui.custom === "function"
               ? await ctx.ui.custom<AskBatchResult | null>(factory, buildCustomUIOptions(displayMode, (handle) => { overlayHandle = handle; }))
               : undefined;
            if (result === undefined) {
               idleTimeout?.stop();
               removeAbortListener?.();
               result = await askBatchViaDialogs(ctx.ui, questions, timeout, markTimedOut, signal, showCountdown);
            }
            if (!result || signal?.aborted || timedOut) {
               if (timedOut) {
                  timer.notifyTimeout(ctx);
                  pi.events.emit("dispensable-ask:timeout", { questions });
                  return {
                     content: [{ type: "text" as const, text: `No batch was submitted within ${formatTimeout(timer.config.timeoutSeconds)} of inactivity. Draft answers were discarded. Continue using your best judgment and do not retry the same questions.` }],
                     details: { ...cancelledDetails(), timedOut: true },
                  };
               }
               pi.events.emit("ask:cancelled", { questions });
               return { content: [{ type: "text" as const, text: "User cancelled the batch. No draft answers were submitted." }], details: cancelledDetails() };
            }
            pi.events.emit("ask:answered", { questions, answers: result.answers });
            return {
               content: [{ type: "text" as const, text: `User submitted answers:\n${JSON.stringify(result, null, 2)}` }],
               details: { questions, answers: result.answers, cancelled: false } as AskToolDetails,
            };
         } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
               content: [{ type: "text" as const, text: `Ask tool failed: ${message}` }], isError: true,
               details: { ...cancelledDetails(), error: message } as AskToolDetails,
            };
         } finally {
            idleTimeout?.stop();
            removeAbortListener?.();
            removeOverlayInputListener?.();
            if (blocked) pi.events.emit("herdr:blocked", { active: false });
            timer.activeAsk = false;
            if (ctx.ui) timer.refreshStatus(ctx);
         }
      },

      renderCall(args, theme) {
         // Display old transcript calls as well; execution only accepts questions.
         const legacyArgs = args as unknown as Record<string, unknown>;
         const questions = Array.isArray(args.questions) ? args.questions : legacyArgs.question ? [legacyArgs] : [];
         let text = theme.fg("toolTitle", theme.bold(`ask_user (${questions.length} question(s))`));
         for (const [index, value] of questions.entries()) {
            if (!value || typeof value !== "object") continue;
            const question = value as Record<string, unknown>;
            text += "\n" + theme.fg("muted", `${index + 1}. ${question.question ?? ""}`);
            if (Array.isArray(question.options) && question.options.length) {
               text += "\n" + theme.fg("dim", `  Options: ${question.options.map((option) => coerceOption(option)?.title ?? "<invalid>").join(", ")}`);
            }
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme) {
         const details = result.details as (AskToolDetails & { error?: string; response?: AskResponse; question?: string; context?: string; options?: AskQuestion["options"] }) | undefined;
         if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
         if (options.isPartial) return new Text(theme.fg("muted", "Waiting for answers and final submission..."), 0, 0);
         if (details?.timedOut) return new Text(theme.fg("warning", "Timed out — drafts discarded"), 0, 0);
         const answers = details?.answers ?? (details?.response ? [{ index: 1, question: details.question ?? "", response: details.response }] : null);
         if (!details || details.cancelled || !answers) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         const lines: string[] = [];
         for (const answer of answers) {
            lines.push(theme.fg("success", `✓ ${answer.index}. `) + theme.fg("accent", formatResponseSummary(answer.response)));
            if (!options.expanded) continue;
            const question = details.questions?.[answer.index - 1] ?? { question: details.question, context: details.context, options: details.options ?? [] };
            lines.push(theme.fg("dim", `Q: ${question.question}`));
            if (question.context) lines.push(theme.fg("dim", question.context));
            if (isSelectionResponse(answer.response)) {
               const selected = new Set(answer.response.selections);
               for (const option of question.options) {
                  const marker = selected.has(option.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
                  lines.push(`  ${marker} ${theme.fg("dim", `${option.title}${option.description ? ` — ${option.description}` : ""}`)}`);
               }
            }
         }
         return new Text(lines.join("\n"), 0, 0);
      },
   });
}
