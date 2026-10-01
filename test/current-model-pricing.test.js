"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");
const { lookupPricing } = require("../src/lib/pricing/matcher");

// Official launch/current rates, verified 2026-10-01. Source URLs and dates
// live beside the entries in curated-overrides.json.
const models = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5-5-fast": [8, 40, 0.4, 10],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "gpt-6.1-sol": [2, 10, 0.1, 2.5],
};
const rates = (p) => [p.input, p.output, p.cache_read, p.cache_write];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("exact LiteLLM models beat contained curated parent versions", () => {
  const curated = { exact: { "claude-fable-5": { input: 10, cache_read: 1 } }, fuzzy: [] };
  for (const model of ["claude-fable-5-1", "claude-fable-5.1"]) {
    const expected = { input: 10, cache_read: 0.25 };
    const result = lookupPricing(model, { curated, litellm: { [model]: expected } });
    assert.equal(result.source, "litellm:exact");
    assert.equal(result.value, expected);
  }
  assert.equal(lookupPricing("claude-fable-5-1", { curated, litellm: {} }).hit, false,
    "dot-restored containment must not silently price a newer minor version as its parent");
});

test("current models and decorated aliases use the same official rates offline", () => {
  for (const [model, expected] of Object.entries(models)) {
    const source = model.startsWith("claude") ? "claude" : "codex";
    const aliases = [model, model.toUpperCase(), `${model}-high`, `provider/${model}`];
    if (source === "claude") aliases.push(model.replace(/-(\d+)-(\d+)/, "-$1.$2"));
    for (const alias of aliases) {
      assert.deepEqual(rates(pricing.getModelPricing(alias, { source })), expected, alias);
    }
  }
  assert.equal(pricing.computeRowCost({ source: "claude", model: "claude-fable-5-1", cached_input_tokens: 1_000_000 }), 0.25);
  assert.equal(pricing.computeRowCost({ source: "claude", model: "claude-opus-5-5", cached_input_tokens: 1_000_000 }), 0.2);
});

test("GPT-6.1 Sol preserves observed long-context/Fast premiums and reasoning subset semantics", () => {
  const row = { source: "codex", model: "gpt-6.1-sol", input_tokens: 100_000, cached_input_tokens: 50_000,
    output_tokens: 10_000, reasoning_output_tokens: 5_000 };
  close(pricing.computeRowCost(row), 0.305);
  const long = { ...row, long_context_input_tokens: 100_000, long_context_cached_input_tokens: 50_000,
    long_context_output_tokens: 10_000, long_context_reasoning_output_tokens: 5_000 };
  close(pricing.computeRowCost(long), 0.56);
  close(pricing.computeRowCost({ ...long, priority_input_tokens: 100_000, priority_cached_input_tokens: 50_000,
    priority_output_tokens: 10_000, priority_long_context_input_tokens: 100_000,
    priority_long_context_cached_input_tokens: 50_000, priority_long_context_output_tokens: 10_000 }), 1.12);
});

test("all five edge pricing blocks match local standard model rates", () => {
  for (const slug of ["leaderboard-refresh", "account-daily", "account-summary", "account-model-breakdown", "leaderboard-profile"]) {
    const source = fs.readFileSync(path.join(__dirname, `../dashboard/edge-patches/tokentracker-${slug}.ts`), "utf8");
    const block = source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/)[0];
    const context = vm.createContext({});
    vm.runInContext(transformSync(block, { loader: "ts", format: "cjs" }).code, context);
    for (const [model, expected] of Object.entries(models)) {
      for (const alias of [model, model.toUpperCase(), `${model}-high`, `provider/${model}`, model.replace(/-(\d+)-(\d+)/, "-$1.$2")]) {
        assert.deepEqual(rates(context.getModelPricing(alias)), expected, `${slug}: ${alias}`);
      }
    }
  }
});
