import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDispensableAsk } from "./src/extension/register-dispensable-ask";

export default function dispensableAsk(pi: ExtensionAPI) {
  return registerDispensableAsk(pi);
}
