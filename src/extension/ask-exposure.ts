import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTimeout, type DispensableAskConfig } from "../config/config";
import { MODEL_TOOL_NAME } from "../ask-user/constants";
import { renderStatus, STATUS_KEY } from "./status";

/** Owns session-local exposure state; global configuration is injected. */
export class AskExposure {
   public activeAsk = false;
   public enabled = false;

   public constructor(
      private readonly pi: ExtensionAPI,
      public config: DispensableAskConfig,
   ) {}

   public refreshStatus(ctx: ExtensionContext): void {
      ctx.ui.setStatus(STATUS_KEY, renderStatus(this.enabled, undefined, ctx));
   }

   public showCountdown(ctx: ExtensionContext, remainingSeconds: number): void {
      ctx.ui.setStatus(STATUS_KEY, renderStatus(true, remainingSeconds, ctx));
   }

   public apply(nextEnabled: boolean): void {
      this.enabled = nextEnabled;
      const activeTools = this.pi.getActiveTools().filter((name) => name !== MODEL_TOOL_NAME);
      this.pi.setActiveTools(nextEnabled ? [...activeTools, MODEL_TOOL_NAME] : activeTools);
   }

   public setFromUser(nextEnabled: boolean, ctx: ExtensionContext): void {
      if (this.activeAsk) {
         ctx.ui.notify("ask_user is waiting for an answer; its state was not changed", "warning");
         return;
      }

      this.apply(nextEnabled);
      this.refreshStatus(ctx);
      ctx.ui.notify(
         `ask_user ${nextEnabled ? "enabled" : "disabled"} for this session`,
         nextEnabled ? "info" : "warning",
      );
   }

   public disableAfterTimeout(ctx: ExtensionContext): void {
      this.apply(false);
      this.refreshStatus(ctx);
      ctx.ui.notify(
         `ask_user timed out after ${formatTimeout(this.config.timeoutSeconds)} and is disabled for this session`,
         "warning",
      );
   }
}
