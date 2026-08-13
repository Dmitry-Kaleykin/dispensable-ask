import type { QuestionOption } from "./ui/single-select-layout";

export type AskOptionInput = QuestionOption | string;

export type AskDisplayMode = "overlay" | "inline";
export type AskSingleSelectLayout = "auto" | "list";

export interface AskParams {
   question: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
}

export type AskResponse =
   | {
      kind: "selection";
      selections: string[];
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

export interface AskToolDetails {
   question: string;
   context?: string;
   options: QuestionOption[];
   response: AskResponse | null;
   cancelled: boolean;
   timedOut?: boolean;
}

export type AskUIResult = AskResponse;

// Key aliases models fall back to when a schema-mangling proxy (Google
// function calling, Codex-style backends, cmux) strips the option shape and
// the model has to guess. See issue #22.
export const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

export function coerceOption(option: unknown): QuestionOption | null {
   if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
      const title = String(option).trim();
      return title ? { title } : null;
   }
   if (option && typeof option === "object") {
      const record = option as Record<string, unknown>;
      for (const key of OPTION_TITLE_KEYS) {
         const value = record[key];
         if (typeof value === "string" && value.trim()) {
            const description =
               typeof record.description === "string" && record.description.trim() ? record.description : undefined;
            return description ? { title: value.trim(), description } : { title: value.trim() };
         }
      }
   }
   return null;
}

export function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

export function parseBooleanPreference(value: string | undefined): boolean | undefined {
   if (value === undefined) return undefined;
   switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
         return true;
      case "0":
      case "false":
      case "no":
      case "off":
         return false;
      default:
         return undefined;
   }
}

export function createFreeformResponse(text: string | null | undefined): AskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

export function createSelectionResponse(selections: string[], comment?: string | null): AskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections };
}

export function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "freeform") return response.text;

   const selections = response.selections.join(", ");
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

export function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

export function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

export function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

export function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
   return response.kind === "selection";
}
