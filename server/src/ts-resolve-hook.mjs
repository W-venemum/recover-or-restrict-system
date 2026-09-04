/**
 * ESM resolution hook that maps `.js` import specifiers back to their `.ts`
 * source when running the TypeScript sources directly via
 * `node --experimental-strip-types`.
 *
 * The source files use NodeNext-style `.js` extensions on relative imports
 * (required so the compiled `dist` output resolves correctly). Node's built-in
 * type stripping does not rewrite those specifiers, so running the raw `.ts`
 * would otherwise fail with ERR_MODULE_NOT_FOUND. This hook resolves the
 * `.js` specifier to the sibling `.ts` file when it exists.
 *
 * Registered via `--import ./src/register-ts.mjs` for the dev/seed/migrate
 * scripts. It has zero effect on the compiled build.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const parentUrl = context.parentURL;
    if (parentUrl) {
      const candidateUrl = new URL(specifier, parentUrl);
      const tsUrl = new URL(candidateUrl.href.replace(/\.js$/, ".ts"));
      if (existsSync(fileURLToPath(tsUrl))) {
        return {
          url: tsUrl.href,
          shortCircuit: true,
        };
      }
    }
  }
  return nextResolve(specifier, context);
}

