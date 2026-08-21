/**
 * Root entry point of the pi-web-scout Pi extension.
 *
 * Pi loads the extension through the `"pi".extensions` entry in
 * `package.json` (`./index.ts`), which resolves to this file. It re-exports
 * the extension factory defined in `src/index.ts` as the default export,
 * keeping the package root a thin entry point while all initialization and
 * registration logic lives in `src/`.
 */

export { default } from "./src/index.js";
