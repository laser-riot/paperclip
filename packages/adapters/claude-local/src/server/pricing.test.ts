import { describe, expect, it } from "vitest";
import {
  estimateClaudeCostUsd,
  resolveClaudeModelRates,
  CLAUDE_MODEL_RATES,
  SUBSCRIPTION_DISCOUNT_DIVISOR,
} from "./pricing.js";

describe("resolveClaudeModelRates", () => {
  it("resolves the exact Opus 4.7 model id", () => {
    expect(resolveClaudeModelRates("claude-opus-4-7")).toEqual(CLAUDE_MODEL_RATES["claude-opus-4-7"]);
  });

  it("resolves version-qualified Sonnet ids by longest-prefix match", () => {
    const rates = resolveClaudeModelRates("claude-sonnet-4-5-20250929");
    expect(rates).toEqual(CLAUDE_MODEL_RATES["claude-sonnet-4-5"]);
  });

  it("resolves Bedrock-qualified ids by stripping the region/vendor prefix", () => {
    const rates = resolveClaudeModelRates("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(rates).toEqual(CLAUDE_MODEL_RATES["claude-haiku-4-5"]);
  });

  it("returns null for unknown model ids", () => {
    expect(resolveClaudeModelRates("gpt-4o")).toBeNull();
    expect(resolveClaudeModelRates("")).toBeNull();
    expect(resolveClaudeModelRates(null)).toBeNull();
  });
});

describe("estimateClaudeCostUsd", () => {
  it("returns zero when usage is missing or all-zero", () => {
    expect(estimateClaudeCostUsd({ model: "claude-opus-4-7", usage: null }).costUsd).toBe(0);
    expect(
      estimateClaudeCostUsd({
        model: "claude-opus-4-7",
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      }).costUsd,
    ).toBe(0);
  });

  it("computes Opus rates ÷ 5 for a 1M / 1M / 1M token mix", () => {
    const result = estimateClaudeCostUsd({
      model: "claude-opus-4-7",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    // (15 + 1.5 + 75) / 5 = 18.30
    expect(result.costUsd).toBeCloseTo(18.3, 5);
    expect(result.matchedKnownModel).toBe(true);
  });

  it("uses Sonnet rates for a Sonnet model — significantly cheaper than Opus", () => {
    const opus = estimateClaudeCostUsd({
      model: "claude-opus-4-7",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
    });
    const sonnet = estimateClaudeCostUsd({
      model: "claude-sonnet-4-6",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
    });
    expect(sonnet.costUsd).toBeLessThan(opus.costUsd);
    // Sonnet: (3 + 15) / 5 = 3.60
    expect(sonnet.costUsd).toBeCloseTo(3.6, 5);
  });

  it("falls back to Opus rates for unknown models and flags matchedKnownModel=false", () => {
    const result = estimateClaudeCostUsd({
      model: "claude-future-model-v9",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
    });
    expect(result.matchedKnownModel).toBe(false);
    // Opus input: 15 / 5 = 3.00
    expect(result.costUsd).toBeCloseTo(3.0, 5);
  });

  it("applies the documented subscription-discount divisor", () => {
    const result = estimateClaudeCostUsd({
      model: "claude-opus-4-7",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
    });
    // 15 / divisor
    expect(result.costUsd * SUBSCRIPTION_DISCOUNT_DIVISOR).toBeCloseTo(15, 5);
  });
});
