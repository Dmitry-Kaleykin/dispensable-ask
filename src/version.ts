import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const DISPENSABLE_ASK_VERSION: string = (require("../package.json") as { version: string }).version;
