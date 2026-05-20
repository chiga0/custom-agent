// Output budget accountant for tool executions.
//
// Each tool invocation gets a `BudgetAccumulator` from the router. The
// accumulator caps total emitted bytes (default 64 KiB) and exposes a
// `truncated` flag so the router can emit `tool.completed { truncated: true }`
// when output was cut short. Per-line truncation is the caller's choice
// — the accumulator just enforces the running total.

export const DEFAULT_OUTPUT_BUDGET_BYTES = 64 * 1024;
const TRUNCATION_SUFFIX = "\n…[output truncated: budget exceeded]";

export class BudgetAccumulator {
  private remainingBytes: number;
  private hasTruncated = false;

  constructor(public readonly limitBytes: number = DEFAULT_OUTPUT_BUDGET_BYTES) {
    this.remainingBytes = limitBytes;
  }

  /**
   * Add `text` to the budget and return what survives. Once the limit
   * is reached the truncation suffix is appended exactly once and all
   * further `take` calls return the empty string.
   */
  take(text: string): string {
    if (this.hasTruncated) return "";
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= this.remainingBytes) {
      this.remainingBytes -= bytes;
      return text;
    }
    // Cut to byte-budget boundary on a UTF-8 char boundary. Buffer
    // slicing in the middle of a multi-byte char would produce a
    // broken string; toString("utf8") drops the partial trailing
    // sequence safely.
    const head = Buffer.from(text, "utf8").subarray(0, this.remainingBytes).toString("utf8");
    this.remainingBytes = 0;
    this.hasTruncated = true;
    return head + TRUNCATION_SUFFIX;
  }

  get truncated(): boolean {
    return this.hasTruncated;
  }
}
