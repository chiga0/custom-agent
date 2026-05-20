import { describe, expect, it } from "vitest";
import { BudgetAccumulator, DEFAULT_OUTPUT_BUDGET_BYTES } from "./budget";

describe("BudgetAccumulator", () => {
  it("default limit is 64 KiB", () => {
    expect(DEFAULT_OUTPUT_BUDGET_BYTES).toBe(64 * 1024);
  });

  it("passes through text below the limit unchanged", () => {
    const b = new BudgetAccumulator(100);
    expect(b.take("hello")).toBe("hello");
    expect(b.truncated).toBe(false);
  });

  it("truncates with the canonical suffix once the limit is reached", () => {
    const b = new BudgetAccumulator(5);
    const out = b.take("hello world");
    expect(out.startsWith("hello")).toBe(true);
    expect(out).toMatch(/output truncated/);
    expect(b.truncated).toBe(true);
  });

  it("subsequent takes after truncation return empty string", () => {
    const b = new BudgetAccumulator(2);
    b.take("xx");
    b.take("more"); // triggers truncation
    expect(b.take("never")).toBe("");
    expect(b.take("again")).toBe("");
  });

  it("counts bytes (utf-8) not characters — chinese is multi-byte", () => {
    // 中 is 3 bytes in UTF-8.
    const b = new BudgetAccumulator(4);
    const out = b.take("中中");
    // First "中" (3 bytes) fits, second "中" (3 bytes) exceeds.
    expect(out).toMatch(/output truncated/);
    expect(b.truncated).toBe(true);
  });

  it("emits accumulated bytes in submission order across multiple takes", () => {
    const b = new BudgetAccumulator(11);
    expect(b.take("hello ")).toBe("hello ");
    expect(b.take("world")).toBe("world");
    expect(b.truncated).toBe(false);
  });
});
