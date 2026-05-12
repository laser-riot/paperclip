import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

function buildStreamJson(events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("parseClaudeStreamJson cost reporting", () => {
  const baseEvents = [
    { type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-4-7" },
    {
      type: "assistant",
      session_id: "s-1",
      message: { content: [{ type: "text", text: "ok" }] },
    },
  ];

  it("passes through a positive total_cost_usd as actual cost", () => {
    const stdout = buildStreamJson([
      ...baseEvents,
      {
        type: "result",
        session_id: "s-1",
        result: "done",
        total_cost_usd: 0.42,
        usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 },
      },
    ]);

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.costUsd).toBe(0.42);
    expect(parsed.costSource).toBe("actual");
  });

  it("estimates cost when total_cost_usd is 0 and tokens were spent (subscription auth)", () => {
    const stdout = buildStreamJson([
      ...baseEvents,
      {
        type: "result",
        session_id: "s-1",
        result: "done",
        total_cost_usd: 0,
        usage: {
          input_tokens: 1_000_000,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    ]);

    const parsed = parseClaudeStreamJson(stdout);
    // Opus input: 15 / 5 = 3.00
    expect(parsed.costSource).toBe("estimated");
    expect(parsed.costUsd ?? 0).toBeCloseTo(3.0, 5);
  });

  it("keeps cost at 0 / actual when total_cost_usd is 0 and no tokens were spent", () => {
    const stdout = buildStreamJson([
      ...baseEvents,
      {
        type: "result",
        session_id: "s-1",
        result: "done",
        total_cost_usd: 0,
        usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    ]);

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.costUsd).toBe(0);
    expect(parsed.costSource).toBe("actual");
  });

  it("estimates cost when total_cost_usd is missing entirely but usage is reported", () => {
    const stdout = buildStreamJson([
      ...baseEvents,
      {
        type: "result",
        session_id: "s-1",
        result: "done",
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1_000_000,
        },
      },
    ]);

    const parsed = parseClaudeStreamJson(stdout);
    // Opus output: 75 / 5 = 15.00
    expect(parsed.costSource).toBe("estimated");
    expect(parsed.costUsd ?? 0).toBeCloseTo(15.0, 5);
  });

  it("reports costSource=unknown when no result event is emitted", () => {
    const stdout = buildStreamJson(baseEvents);
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.costUsd).toBeNull();
    expect(parsed.costSource).toBe("unknown");
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});
