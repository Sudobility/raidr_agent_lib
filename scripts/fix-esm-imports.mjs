#!/usr/bin/env node
// Post-build step: make tsc's ESM output resolvable by Node's native ESM loader.
//
// The package is built with `tsc` under `moduleResolution: "bundler"`, which
// accepts extensionless and directory relative imports (`from './core'`) and
// emits them verbatim. Node's ESM resolver — used whenever a consumer's bundler
// externalizes this package, or when it runs under Node directly — rejects
// those: relative specifiers must be fully-qualified files.
//
// This script rewrites every relative import/export specifier in the emitted
// `.js` and `.d.ts` files to an explicit path:
//   ./core        -> ./core/index.js   (directory with an index)
//   ../utils/x     -> ../utils/x.js      (file)
//   ./common.ts    -> ./common.js        (TS source extension -> JS output)
// Specifiers that already carry a runtime extension (.js/.json/.css/.vue/...)
// are left untouched. Specifiers that cannot be resolved — dynamic
// template-literal imports, platform-resolved files, or examples inside doc
// comments — are reported as warnings but never fail the build. It is
// idempotent and dependency-free, so it can run after every build.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Imported explicitly (rather than relying on globals) so this build script
// lints cleanly under every repo's ESLint config without needing a directive.
const out = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`${msg}\n`);

// Output directory: an explicit argument wins, otherwise `dist` under the
// current working directory (where `bun run build` runs), falling back to the
// package root inferred from this script's location.
const distDir = process.argv[2]
  ? resolve(process.argv[2])
  : existsSync(resolve(process.cwd(), 'dist'))
    ? resolve(process.cwd(), 'dist')
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

if (!existsSync(distDir)) {
  warn(`[fix-esm-imports] dist directory not found: ${distDir}`);
  process.exit(1);
}

/** Recursively collect .js and .d.ts files under a directory. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Matches the specifier of: `from '...'`, side-effect `import '...'`, and
// dynamic/type `import('...')` (the latter also covers the inline
// `import("..")` type references tsc emits into .d.ts files). Group 1 is the
// leading context, group 2 the quote, group 3 the specifier. The specifier is
// any relative form: `.`, `..`, `./x`, `../x/y`.
const SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)(['"])(\.\.?(?:\/[^'"]*)?)\2/g;

// A TypeScript source extension maps to its emitted JavaScript counterpart.
const TS_TO_JS = { '.ts': '.js', '.tsx': '.js', '.mts': '.mjs', '.cts': '.cjs' };
// Runtime extensions that are already valid specifiers — leave them untouched.
const RUNTIME_EXT =
  /\.(mjs|cjs|js|jsx|json|css|scss|sass|less|node|wasm|vue|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|eot|md|txt|html?)$/i;

const LEAVE = Symbol('leave'); // valid as-is, no action
const UNRESOLVED = Symbol('unresolved'); // report, but do not fail

/**
 * Resolve a relative specifier against the importing file.
 * Returns a replacement string, LEAVE (already valid), or UNRESOLVED (warn).
 */
function resolveSpecifier(fromFile, spec, isDts) {
  const baseDir = dirname(fromFile);

  // 1) TypeScript source extension -> JavaScript output extension. Node's ESM
  //    loader cannot import a `.ts` specifier, so this must always be rewritten.
  for (const [tsExt, jsExt] of Object.entries(TS_TO_JS)) {
    if (spec.endsWith(tsExt)) return spec.slice(0, -tsExt.length) + jsExt;
  }

  // 2) Already a valid runtime specifier.
  if (RUNTIME_EXT.test(spec)) return LEAVE;

  const target = resolve(baseDir, spec);

  // 3) A file (with an extension appended). File takes precedence over a
  //    directory index, matching Node's resolution order.
  const fileExts = isDts ? ['.d.ts', '.js'] : ['.js'];
  for (const ext of fileExts) {
    if (existsSync(target + ext)) return spec.replace(/\/+$/, '') + '.js';
  }

  // 4) A directory with an index file.
  const dirIndexes = isDts ? ['index.d.ts', 'index.js'] : ['index.js'];
  if (existsSync(target) && statSync(target).isDirectory()) {
    for (const idx of dirIndexes) {
      if (existsSync(join(target, idx))) return spec.replace(/\/?$/, '/') + 'index.js';
    }
  }

  // 5) Could not resolve: a dynamic template-literal import, a platform/bundler
  //    conditional file, or an example inside a doc comment. Leave it as-is.
  return UNRESOLVED;
}

let filesChanged = 0;
let specifiersRewritten = 0;
const unresolved = [];

for (const file of collect(distDir)) {
  const isDts = file.endsWith('.d.ts');
  const src = readFileSync(file, 'utf8');
  let localRewrites = 0;

  const next = src.replace(SPECIFIER_RE, (match, lead, quote, spec) => {
    const resolved = resolveSpecifier(file, spec, isDts);
    if (resolved === LEAVE) return match;
    if (resolved === UNRESOLVED) {
      unresolved.push(`${file}: ${spec}`);
      return match;
    }
    if (resolved === spec) return match; // already correct; no change
    localRewrites++;
    return `${lead}${quote}${resolved}${quote}`;
  });

  if (localRewrites > 0) {
    writeFileSync(file, next);
    filesChanged++;
    specifiersRewritten += localRewrites;
  }
}

out(
  `[fix-esm-imports] rewrote ${specifiersRewritten} specifier(s) across ${filesChanged} file(s) in ${distDir}`,
);

// Unresolved specifiers are reported for visibility but never fail the build:
// they are dynamic imports, platform-conditional files, or doc-comment examples
// that this rewrite deliberately leaves alone.
if (unresolved.length > 0) {
  warn(`[fix-esm-imports] ${unresolved.length} specifier(s) left as-is (could not resolve):`);
  for (const u of unresolved) warn(`  - ${u}`);
}
