import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type KeybindingsManager, type OverlayHandle, Text, type TUI,
} from "@earendil-works/pi-tui";
import { formatTimeout } from "../config/config";
import type { AskExposure } from "../extension/ask-exposure";
import { MODEL_TOOL_NAME } from "./constants";
import { askViaDialogs, runDialogWithIdleTimeout } from "./dialogs";
import { IdleTimeout } from "./idle-timeout";
import {
  type AskDisplayMode, type AskParams, type AskSingleSelectLayout,
  type AskToolDetails, type AskUIResult, coerceOption, createFreeformResponse,
  formatOptionsForMessage, formatResponseSummary, isSelectionResponse,
  parseBooleanPreference,
} from "./model";
import { AskComponent } from "./ui/ask-component";
import type { QuestionOption } from "./ui/single-select-layout";
import {
  DEFAULT_COMMENT_TOGGLE_KEY, DEFAULT_OVERLAY_TOGGLE_KEY,
  type ResolvedAskShortcuts, buildCustomUIOptions, resolveShortcut,
} from "./ui/shared";

export function registerAskUserTool(pi: ExtensionAPI, exposure: AskExposure): void {
   pi.registerTool({
      name: MODEL_TOOL_NAME,
      label: "Dispensable Ask",
      description:
         "Ask the user one focused question. Call this tool immediately when the user explicitly asks you to call or test ask_user; the explicit request is sufficient reason. Otherwise, use it when you are blocked, especially when you are revisiting the same decision instead of making progress. Never imitate the tool by writing its question or options as ordinary prose. Do not re-ask decisions the user already made. The user may not answer; if the request times out, continue using your best judgment.",
      promptSnippet:
         "Ask one focused question when explicitly requested, blocked, or repeatedly revisiting a decision",
      promptGuidelines: [
         "If the user explicitly asks you to call or test ask_user, call ask_user immediately. The request itself is sufficient context; do not invent or wait for another reason.",
         "Do not reproduce an ask_user question or its options as ordinary assistant prose; make the tool call instead.",
         "For calls that were not explicitly requested by the user, first gather available context and pass a short summary via the context field.",
         "Prefer ask_user over repeatedly reconsidering the same user-dependent decision.",
         "Ask exactly one focused question per ask_user call.",
         "Do not ask for confirmation of a decision the user already made.",
         "If ask_user times out or is disabled, continue with your best judgment instead of retrying.",
      ],
      // Block other tool calls in the same assistant turn until the user answers,
      // so the model can't batch ask_user with bash/edit/write and let those run
      // (potentially with side effects) before the user sees the prompt.
      executionMode: "sequential",
      parameters: Type.Object({
         question: Type.String({ description: "The question to ask the user" }),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(
               // Flat object shape: union item schemas get stripped or rejected
               // by several providers/proxies (Google function calling,
               // Codex-style backends, cmux), leaving the model to guess the shape
               // and produce empty options. Plain strings are still accepted at
               // runtime for older transcripts. See issue #22.
               Type.Object({
                  title: Type.String({ description: "Short title for this option" }),
                  description: Type.Optional(
                     Type.String({ description: "Longer description explaining this option" }),
                  ),
               }),
               { description: "List of options for the user to choose from" },
            ),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: DISPENSABLE_ASK_ALLOW_COMMENT env var if set, otherwise false." }),
         ),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         if (!exposure.enabled) {
            return {
               content: [{ type: "text", text: "ask_user is disabled; continue without asking the user" }],
               isError: true,
               details: { error: "Tool disabled for this session" },
            };
         }

         if (signal?.aborted) {
            return {
               content: [{ type: "text", text: "Cancelled" }],
               details: { question: params.question, options: [], response: null, cancelled: true } as AskToolDetails,
            };
         }

         exposure.activeAsk = true;
         try {
         const {
            question,
            context,
            options: rawOptions = [],
            allowMultiple = false,
            allowFreeform = true,
            allowComment: requestedAllowComment,
         } = params as AskParams;
         const timeout = exposure.config.timeoutSeconds * 1000;
         let timedOut = false;
         const markTimedOut = () => {
            timedOut = true;
         };
         const envMode = process.env.DISPENSABLE_ASK_DISPLAY_MODE?.trim().toLowerCase();
         const envDisplayMode: AskDisplayMode | undefined =
            envMode === "overlay" || envMode === "inline" ? envMode : undefined;
         const effectiveDisplayMode: AskDisplayMode = envDisplayMode ?? "overlay";
         const envSingleSelectLayout = process.env.DISPENSABLE_ASK_SINGLE_SELECT_LAYOUT?.trim().toLowerCase();
         const effectiveSingleSelectLayout: AskSingleSelectLayout =
            envSingleSelectLayout === "list" ? "list" : "auto";
         const allowComment = requestedAllowComment
            ?? parseBooleanPreference(process.env.DISPENSABLE_ASK_ALLOW_COMMENT)
            ?? false;
         const shortcuts: ResolvedAskShortcuts = {
            overlayToggle: resolveShortcut(
               undefined,
               process.env.DISPENSABLE_ASK_OVERLAY_TOGGLE_KEY,
               DEFAULT_OVERLAY_TOGGLE_KEY,
            ),
            commentToggle: resolveShortcut(
               undefined,
               process.env.DISPENSABLE_ASK_COMMENT_TOGGLE_KEY,
               DEFAULT_COMMENT_TOGGLE_KEY,
            ),
         };
         const options = rawOptions.map(coerceOption).filter((option): option is QuestionOption => option !== null);
         const normalizedContext = context?.trim() || undefined;

         if (rawOptions.length > 0 && options.length === 0) {
            return {
               content: [
                  {
                     type: "text",
                     text:
                        `All ${rawOptions.length} option(s) were malformed, so nothing could be shown to the user. `
                        + `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. `
                        + `Call ask_user again with corrected options.`,
                  },
               ],
               isError: true,
               details: { error: "Malformed options: no entry had a usable title" },
            };
         }

         if (!ctx.hasUI || !ctx.ui) {
            const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
            const freeformHint = allowFreeform ? "\n\nYou can also answer freely." : "";
            const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
            const contextText = normalizedContext ? `\n\nContext:\n${normalizedContext}` : "";
            return {
               content: [
                  {
                     type: "text",
                     text: `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}${commentHint}`,
                  },
               ],
               isError: true,
               details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
            };
         }

         if (options.length === 0) {
            const prompt = normalizedContext ? `${question}\n\nContext:\n${normalizedContext}` : question;
            pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
            let answer: string | undefined;
            try {
               answer = await runDialogWithIdleTimeout(
                  ctx.ui,
                  timeout,
                  markTimedOut,
                  (dialogOptions) => ctx.ui.input(prompt, "Type your answer...", dialogOptions),
                  signal,
               );
            } finally {
               pi.events.emit("herdr:blocked", { active: false });
            }
            const response = createFreeformResponse(answer);

            if (!response) {
               if (timedOut) {
                  exposure.disableAfterTimeout(ctx);
                  return {
                     content: [{
                        type: "text",
                        text: `No answer was received within ${formatTimeout(exposure.config.timeoutSeconds)}. ask_user is now disabled for this session. Continue using your best judgment and do not retry unless the user manually re-enables it.`,
                     }],
                     details: {
                        question,
                        context: normalizedContext,
                        options,
                        response: null,
                        cancelled: true,
                        timedOut: true,
                     } as AskToolDetails,
                  };
               }
               return {
                  content: [{ type: "text", text: "User cancelled the question" }],
                  details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
               };
            }

            pi.events.emit("ask:answered", { question, context: normalizedContext, response });
            return {
               content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
               details: { question, context: normalizedContext, options, response, cancelled: false } as AskToolDetails,
            };
         }

         onUpdate?.({
            content: [{ type: "text", text: "Waiting for user input..." }],
            details: { question, context: normalizedContext, options, response: null, cancelled: false },
         });

         let result: AskUIResult | null;
         let overlayHandle: OverlayHandle | undefined;
         let removeOverlayInputListener: (() => void) | undefined;
         let idleTimeout: IdleTimeout | undefined;
         let hasAnnouncedHide = false;
         pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
         try {
            const customFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AskUIResult | null) => void) => {
               if (signal) {
                  const onAbort = () => done(null);
                  signal.addEventListener("abort", onAbort, { once: true });
               }

               idleTimeout = new IdleTimeout(timeout, () => {
                  markTimedOut();
                  done(null);
               });
               idleTimeout.start();

               return new AskComponent(
                  question,
                  normalizedContext,
                  options,
                  allowMultiple,
                  allowFreeform,
                  allowComment,
                  effectiveDisplayMode,
                  effectiveSingleSelectLayout,
                  tui,
                  theme,
                  keybindings,
                  shortcuts,
                  done,
                  () => idleTimeout?.touch(),
               );
            };

            // Register a raw terminal input listener for the overlay-toggle key so the
            // overlay can be toggled even while it is hidden (hidden overlays do not
            // receive input). Inline mode does not need this because the prompt is
            // already non-modal. Skipped entirely if the user disabled the shortcut.
            const overlayToggle = shortcuts.overlayToggle;
            if (
               effectiveDisplayMode === "overlay"
               && !overlayToggle.disabled
               && typeof ctx.ui.onTerminalInput === "function"
            ) {
               removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
                  if (!overlayToggle.matches(data) || !overlayHandle) return undefined;
                  idleTimeout?.touch();
                  const nextHidden = !overlayHandle.isHidden();
                  overlayHandle.setHidden(nextHidden);
                  if (nextHidden && !hasAnnouncedHide) {
                     hasAnnouncedHide = true;
                     ctx.ui.notify?.(`ask_user hidden — press ${overlayToggle.spec} to reopen`, "info");
                  }
                  return { consume: true };
               });
            }

            const customResult = await ctx.ui.custom<AskUIResult | null>(
               customFactory,
               buildCustomUIOptions(effectiveDisplayMode, (handle) => {
                  overlayHandle = handle;
               }),
            );

            if (customResult !== undefined) {
               result = customResult;
            } else {
               // RPC/headless mode: degrade to select()/input() dialog protocol
               result = await askViaDialogs(
                  ctx.ui,
                  question,
                  normalizedContext,
                  options,
                  allowMultiple,
                  allowFreeform,
                  allowComment,
                  timeout,
                  markTimedOut,
                  signal,
               );
            }
         } catch (error) {
            const message =
               error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
            return {
               content: [{ type: "text", text: `Ask tool failed: ${message}` }],
               isError: true,
               details: { error: message },
            };
         } finally {
            idleTimeout?.stop();
            removeOverlayInputListener?.();
            pi.events.emit("herdr:blocked", { active: false });
         }

         if (result === null) {
            if (timedOut) {
               exposure.disableAfterTimeout(ctx);
               pi.events.emit("dispensable-ask:timeout", { question, context: normalizedContext, options });
               return {
                  content: [{
                     type: "text",
                     text: `No answer was received within ${formatTimeout(exposure.config.timeoutSeconds)}. ask_user is now disabled for this session. Continue using your best judgment and do not retry unless the user manually re-enables it.`,
                  }],
                  details: {
                     question,
                     context: normalizedContext,
                     options,
                     response: null,
                     cancelled: true,
                     timedOut: true,
                  } as AskToolDetails,
               };
            }
            pi.events.emit("ask:cancelled", { question, context: normalizedContext, options });
            return {
               content: [{ type: "text", text: "User cancelled the question" }],
               details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
            };
         }

         pi.events.emit("ask:answered", {
            question,
            context: normalizedContext,
            response: result,
         });
         return {
            content: [{ type: "text", text: `User answered: ${formatResponseSummary(result)}` }],
            details: {
               question,
               context: normalizedContext,
               options,
               response: result,
               cancelled: false,
            } as AskToolDetails,
         };
         } finally {
            exposure.activeAsk = false;
         }
      },

      renderCall(args, theme) {
         const question = (args.question as string) || "";
         const rawOptions = Array.isArray(args.options) ? args.options : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user "));
         text += theme.fg("muted", question);
         if (rawOptions.length > 0) {
            const labels = rawOptions.map((o: unknown) => coerceOption(o)?.title ?? "<invalid>");
            text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
         }
         if (args.allowMultiple) {
            text += theme.fg("dim", " [multi-select]");
         }
         if (args.allowComment) {
            text += theme.fg("dim", " [optional comment]");
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme) {
         const details = result.details as (AskToolDetails & { error?: string }) | undefined;

         if (details?.error) {
            return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
         }

         if (options.isPartial) {
            const waitingText = result.content
               ?.map((part) => part.type === "text" ? part.text : "")
               .join("\n")
               .trim() || "Waiting for user input...";
            return new Text(theme.fg("muted", waitingText), 0, 0);
         }

         if (details?.timedOut) {
            return new Text(theme.fg("warning", `Timed out; disabled for this session`), 0, 0);
         }

         if (!details || details.cancelled || !details.response) {
            return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         }

         const response = details.response;
         let text = theme.fg("success", "✓ ");
         if (response.kind === "freeform") {
            text += theme.fg("muted", "(wrote) ");
         }
         text += theme.fg("accent", formatResponseSummary(response));

         if (options.expanded) {
            text += "\n" + theme.fg("dim", `Q: ${details.question}`);
            if (details.context) {
               text += "\n" + theme.fg("dim", details.context);
            }

            if (isSelectionResponse(response) && details.options.length > 0) {
               const selectedTitles = new Set(response.selections);
               text += "\n" + theme.fg("dim", "Options:");
               for (const opt of details.options) {
                  const desc = opt.description ? ` — ${opt.description}` : "";
                  const marker = selectedTitles.has(opt.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
                  text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
               }
               if (response.comment) {
                  text += `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
               }
            }
         }

         return new Text(text, 0, 0);
      },
   });
}
