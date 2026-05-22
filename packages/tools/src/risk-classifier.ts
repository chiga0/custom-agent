export const SHELL_DENYLIST: readonly RegExp[] = [
  /rm\s+-rf\s+\//,
  /git\s+push\s+--force/,
  /dd\s+if=/,
  /mkfs/,
  />\s*\/dev\/s[da-z]/,
  /chmod\s+-R\s+777\s+\//,
  /\|\s*bash/,
  /\|\s*sh/,
  /eval\s/,
];

export function classifyShellCommand(command: string): "allow" | "deny" {
  for (const pattern of SHELL_DENYLIST) {
    if (pattern.test(command)) {
      return "deny";
    }
  }
  return "allow";
}
