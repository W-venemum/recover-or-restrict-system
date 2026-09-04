/**
 * Registers the `.js` -> `.ts` resolution hook (see ts-resolve-hook.mjs) so the
 * TypeScript sources can run directly with `node --experimental-strip-types`.
 *
 * Used by the dev/seed/migrate npm scripts via `--import ./src/register-ts.mjs`.
 */

import { register } from "node:module";

register(new URL("./ts-resolve-hook.mjs", import.meta.url));
