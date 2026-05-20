import { resolve, sep } from "node:path";

// Path-safety helper for read-only tools.
//
// Every tool that takes a path argument from the model MUST run it
// through `resolveInsideCwd(cwd, rawPath)` and refuse the call if the
// result is `undefined`. The check ensures:
//
//   - relative paths resolve INSIDE `cwd` (no `../../etc/passwd`)
//   - absolute paths are accepted only if they live under `cwd`
//   - symlink escape is OUT OF SCOPE for M3-02 — gitignore + symlink
//     enforcement land with M3-02b (the wiring PR) where we can also
//     read .gitignore via a real ignore parser.
//
// Returns the absolute, normalized path when safe; `undefined` when the
// resolved location is outside `cwd`. Caller is responsible for emitting
// the `tool.failed { errorCode: "path_unsafe" }` event.

export function resolveInsideCwd(cwd: string, rawPath: string): string | undefined {
  const cwdAbs = resolve(cwd);
  const resolved = resolve(cwdAbs, rawPath);
  // The result must equal cwd, be cwd + separator + ..., to count as
  // "inside cwd". Without the separator a directory `cwd-evil` would
  // pass `startsWith(cwd)` despite living outside.
  if (resolved === cwdAbs) return resolved;
  if (resolved.startsWith(cwdAbs + sep)) return resolved;
  return undefined;
}
