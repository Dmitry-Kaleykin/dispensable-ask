import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "../ask-user/register-tool";
import { loadConfig } from "../config/config";
import { AskExposure } from "./ask-exposure";
import { registerControls } from "./register-controls";

/** Package composition root: construct state, then attach controls and tool. */
export async function registerDispensableAsk(pi: ExtensionAPI): Promise<void> {
   const exposure = new AskExposure(pi, await loadConfig());
   registerControls(pi, exposure);
   registerAskUserTool(pi, exposure);
}
