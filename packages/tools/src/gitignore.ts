import ignore, { type Ignore } from "ignore";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BUILTIN_PATTERNS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".turbo/",
  ".vite/",
];

/**
 * Build an ignore filter for the given working directory. Reads
 * `<cwd>/.gitignore` if present and merges with built-in patterns.
 *
 * For directories, callers MUST pass paths with a trailing `/` so
 * directory-only patterns match correctly.
 */
export async function createIgnoreFilter(cwd: string): Promise<(relativePath: string) => boolean> {
  const ig: Ignore = ignore();
  ig.add(BUILTIN_PATTERNS);
  try {
    const content = await readFile(join(cwd, ".gitignore"), "utf8");
    ig.add(content);
  } catch {
    // No .gitignore or unreadable — rely on builtins only.
  }
  return (relPath: string) => relPath !== "" && ig.ignores(relPath);
}
