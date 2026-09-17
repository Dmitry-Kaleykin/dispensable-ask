import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "../ask-user/register-tool";
import { loadConfig } from "../config/config";
import { AskTimer } from "./ask-timer";
import { registerControls } from "./register-controls";

/** Package composition root: construct state, then attach controls and tool. */
export async function registerDispensableAsk(pi: ExtensionAPI): Promise<void> {
   const timer = new AskTimer(await loadConfig());
   registerControls(pi, timer);
   registerAskUserTool(pi, timer);
}
