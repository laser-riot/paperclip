import type { UsageSummary } from "@paperclipai/adapter-utils";

/**
 * Per-million-token rates for Anthropic Claude models in USD, sourced from
 * Anthropic's public API pricing. Used to estimate cost when the Claude Code
 * CLI omits or zeroes `total_cost_usd` (e.g. Max/Pro subscription auth).
 *
 * Estimates are intentionally divided by SUBSCRIPTION_DISCOUNT_DIVISOR to
 * approximate the effective per-token spend under a Max-style subscription
 * versus raw list price.
 */
export interface ClaudeModelRates {
  /** Cost per million uncached input tokens. */
  inputPerMTok: number;
  /** Cost per million cache-read input tokens. */
  cachedInputPerMTok: number;
  /** Cost per million output tokens. */
  outputPerMTok: number;
}

export const SUBSCRIPTION_DISCOUNT_DIVISOR = 5;

const OPUS_RATES: ClaudeModelRates = {
  inputPerMTok: 15,
  cachedInputPerMTok: 1.5,
  outputPerMTok: 75,
};

const SONNET_RATES: ClaudeModelRates = {
  inputPerMTok: 3,
  cachedInputPerMTok: 0.3,
  outputPerMTok: 15,
};

const HAIKU_RATES: ClaudeModelRates = {
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  outputPerMTok: 5,
};

/**
 * Map of Anthropic model id (Anthropic API short name or Bedrock-qualified id)
 * to per-MTok pricing. The lookup is suffix-tolerant so version-qualified ids
 * such as `us.anthropic.claude-opus-4-6-v1` resolve to the right tier.
 */
export const CLAUDE_MODEL_RATES: Record<string, ClaudeModelRates> = {
  "claude-opus-4-7": OPUS_RATES,
  "claude-opus-4-6": OPUS_RATES,
  "claude-sonnet-4-6": SONNET_RATES,
  "claude-sonnet-4-5": SONNET_RATES,
  "claude-haiku-4-6": HAIKU_RATES,
  "claude-haiku-4-5": HAIKU_RATES,
};

function normalizeModelId(model: string): string {
  const lowered = model.trim().toLowerCase();
  if (!lowered) return "";
  // Strip Bedrock region/vendor prefix: `us.anthropic.claude-opus-4-6-v1` -> `claude-opus-4-6-v1`.
  const anthropicMatch = lowered.match(/anthropic\.(claude[\w.-]+)/);
  if (anthropicMatch) return anthropicMatch[1] ?? lowered;
  return lowered;
}

/**
 * Resolve the per-MTok rate table for a given Claude model id. Returns null
 * when the model is unknown so callers can decide whether to fall back to
 * a sensible default (typically Opus, the most expensive tier).
 */
export function resolveClaudeModelRates(model: string | null | undefined): ClaudeModelRates | null {
  const normalized = normalizeModelId(model ?? "");
  if (!normalized) return null;

  if (CLAUDE_MODEL_RATES[normalized]) return CLAUDE_MODEL_RATES[normalized];

  // Suffix match: handles version qualifiers like `-20251001`, `-v1`, `-v2:0`.
  let bestKey: string | null = null;
  for (const key of Object.keys(CLAUDE_MODEL_RATES)) {
    if (normalized.startsWith(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? CLAUDE_MODEL_RATES[bestKey] ?? null : null;
}

/**
 * Compute an estimated subscription-equivalent USD cost from a Claude usage
 * summary. Applies per-model list-price rates divided by
 * SUBSCRIPTION_DISCOUNT_DIVISOR. Returns 0 when no tokens were spent.
 *
 * Unknown models fall back to Opus rates (the highest tier) so estimates
 * stay on the safe side rather than under-counting.
 */
export function estimateClaudeCostUsd(input: {
  model: string | null | undefined;
  usage: UsageSummary | null | undefined;
}): { costUsd: number; rates: ClaudeModelRates; matchedKnownModel: boolean } {
  const usage = input.usage ?? null;
  const rates = resolveClaudeModelRates(input.model);
  const effective = rates ?? OPUS_RATES;
  const matchedKnownModel = rates !== null;

  if (!usage) {
    return { costUsd: 0, rates: effective, matchedKnownModel };
  }

  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens || 0);

  const gross =
    (inputTokens * effective.inputPerMTok +
      cachedInputTokens * effective.cachedInputPerMTok +
      outputTokens * effective.outputPerMTok) /
    1_000_000;

  const costUsd = gross / SUBSCRIPTION_DISCOUNT_DIVISOR;
  return { costUsd, rates: effective, matchedKnownModel };
}
