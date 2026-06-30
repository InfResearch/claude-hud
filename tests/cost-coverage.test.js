import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSessionCost, resolveSessionCost, formatUsd, formatCost } from '../dist/cost.js';

test('estimateSessionCost returns null when sessionTokens is undefined', () => {
  assert.equal(estimateSessionCost({ model: { display_name: 'Claude Opus 4' } }, undefined), null);
});

test('estimateSessionCost returns null for Bedrock model IDs', () => {
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0' } }, tokens);
  assert.equal(result, null);
});

test('estimateSessionCost returns null for Vertex model IDs', () => {
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { id: 'publishers/anthropic/models/claude-sonnet-4@20250514' } }, tokens);
  assert.equal(result, null);
});

test('estimateSessionCost returns null when no model matches pricing', () => {
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'Unknown Model XYZ' } }, tokens);
  assert.equal(result, null);
});

test('estimateSessionCost returns null when total tokens are zero', () => {
  const tokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'Claude Sonnet 4' } }, tokens);
  assert.equal(result, null);
});

test('estimateSessionCost calculates correctly for Sonnet 4', () => {
  const tokens = { inputTokens: 100000, outputTokens: 50000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'Claude Sonnet 4' } }, tokens);
  assert.ok(result);
  // input: 100k * $3/M = $0.30, output: 50k * $15/M = $0.75
  assert.equal(result.inputAmount, 0.3);
  assert.equal(result.outputAmount, 0.75);
  assert.equal(result.totalAmount, 1.05);
  assert.equal(result.currency, 'USD');
});

test('estimateSessionCost calculates cache costs correctly', () => {
  const tokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1000000, cacheReadTokens: 1000000 };
  const result = estimateSessionCost({ model: { display_name: 'Claude Sonnet 4' } }, tokens);
  assert.ok(result);
  // cache creation: 1M * $3 * 1.25 / M = $3.75
  // cache read: 1M * $3 * 0.1 / M = $0.30 (floating point)
  assert.equal(result.cacheCreationAmount, 3.75);
  assert.ok(Math.abs(result.cacheReadAmount - 0.3) < 1e-10);
  assert.ok(Math.abs(result.totalAmount - 4.05) < 1e-10);
});

test('estimateSessionCost matches model from id when display_name fails', () => {
  const tokens = { inputTokens: 1000000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'Unknown', id: 'claude-sonnet-3.5-20241022' } }, tokens);
  assert.ok(result);
  // Sonnet 3.5: $3/M input
  assert.equal(result.inputAmount, 3);
});

test('estimateSessionCost prices enterprise plan aliases', () => {
  const tokens = { inputTokens: 1000000, outputTokens: 1000000, cacheCreationTokens: 0, cacheReadTokens: 0 };

  const opusPlan = estimateSessionCost({ model: { display_name: 'opusplan' } }, tokens);
  assert.ok(opusPlan);
  assert.equal(opusPlan.inputAmount, 15);
  assert.equal(opusPlan.outputAmount, 75);

  const sonnetPlan = estimateSessionCost({ model: { display_name: 'sonnetplan' } }, tokens);
  assert.ok(sonnetPlan);
  assert.equal(sonnetPlan.inputAmount, 3);
  assert.equal(sonnetPlan.outputAmount, 15);

  const haikuPlan = estimateSessionCost({ model: { display_name: 'haikuplan' } }, tokens);
  assert.ok(haikuPlan);
  assert.equal(haikuPlan.inputAmount, 0.8);
  assert.equal(haikuPlan.outputAmount, 4);
});

test('estimateSessionCost prices Sonnet 3.7', () => {
  const tokens = { inputTokens: 1000000, outputTokens: 1000000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'Claude Sonnet 3.7' } }, tokens);
  assert.ok(result);
  assert.equal(result.inputAmount, 3);
  assert.equal(result.outputAmount, 15);
});

test('resolveSessionCost prefers native cost', () => {
  const stdin = {
    model: { display_name: 'Claude Opus 4' },
    cost: { total_cost_usd: 5.0 },
  };
  const result = resolveSessionCost(stdin, undefined);
  assert.deepEqual(result, { totalAmount: 5.0, currency: 'USD', source: 'native' });
});

test('resolveSessionCost ignores native cost for Bedrock models', () => {
  const stdin = {
    model: { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', display_name: 'Sonnet' },
    cost: { total_cost_usd: 1.0 },
  };
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = resolveSessionCost(stdin, tokens);
  // Should be null since Bedrock is excluded from estimation too
  assert.equal(result, null);
});

test('resolveSessionCost ignores native cost for Vertex models', () => {
  const stdin = {
    model: { id: 'publishers/anthropic/models/claude-sonnet-4@20250514', display_name: 'Sonnet' },
    cost: { total_cost_usd: 2.0 },
  };
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = resolveSessionCost(stdin, tokens);
  assert.equal(result, null);
});

test('resolveSessionCost falls back to estimate when native cost is NaN', () => {
  const stdin = {
    model: { display_name: 'Claude Sonnet 4' },
    cost: { total_cost_usd: NaN },
  };
  const tokens = { inputTokens: 100000, outputTokens: 50000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = resolveSessionCost(stdin, tokens);
  assert.ok(result);
  assert.equal(result.source, 'estimate');
});

test('resolveSessionCost returns null when no native cost and no estimate', () => {
  const stdin = {
    model: { display_name: 'Unknown Model' },
  };
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = resolveSessionCost(stdin, tokens);
  assert.equal(result, null);
});

test('resolveSessionCost returns null when native cost is null', () => {
  const stdin = {
    model: { display_name: 'Unknown Model' },
    cost: { total_cost_usd: null },
  };
  const result = resolveSessionCost(stdin, undefined);
  assert.equal(result, null);
});

test('formatUsd formats different ranges correctly', () => {
  assert.equal(formatUsd(10.5), '$10.50');
  assert.equal(formatUsd(1.0), '$1.00');
  assert.equal(formatUsd(0.5), '$0.500');
  assert.equal(formatUsd(0.1), '$0.100');
  assert.equal(formatUsd(0.05), '$0.0500');
  assert.equal(formatUsd(0.001), '$0.0010');
  assert.equal(formatUsd(0.0001), '$0.0001');
});

test('formatCost formats CNY correctly', () => {
  assert.equal(formatCost(10.5, 'CNY'), '¥10.50');
  assert.equal(formatCost(1.0, 'CNY'), '¥1.00');
  assert.equal(formatCost(0.5, 'CNY'), '¥0.500');
  assert.equal(formatCost(0.1, 'CNY'), '¥0.100');
  assert.equal(formatCost(0.001, 'CNY'), '¥0.0010');
});

test('formatCost formats USD correctly', () => {
  assert.equal(formatCost(10.5, 'USD'), '$10.50');
  assert.equal(formatCost(0.0001, 'USD'), '$0.0001');
});

test('estimateSessionCost handles model with no display_name and no id', () => {
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: {} }, tokens);
  assert.equal(result, null);
});

test('estimateSessionCost handles model being undefined', () => {
  const tokens = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({}, tokens);
  assert.equal(result, null);
});

// --- DeepSeek-specific tests ---

test('estimateSessionCost calculates DeepSeek V4 Pro correctly', () => {
  // Simulates:  50k cache miss + 200k cache hit + 100k output
  // cache miss: 50k * ¥3/M = ¥0.15
  // cache hit:  200k * ¥0.025/M = ¥0.005
  // output:     100k * ¥6/M = ¥0.60
  // total: ¥0.755
  const tokens = { inputTokens: 50000, cacheCreationTokens: 0, cacheReadTokens: 200000, outputTokens: 100000 };
  const result = estimateSessionCost({ model: { display_name: 'deepseek-v4-pro[1m]' } }, tokens);
  assert.ok(result);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.inputAmount, 0.15);
  assert.equal(result.cacheReadAmount, 0.005);
  assert.equal(result.outputAmount, 0.6);
  assert.equal(result.totalAmount, 0.755);
  assert.equal(result.cacheCreationAmount, 0); // DeepSeek has no creation billing
});

test('estimateSessionCost calculates DeepSeek V4 Flash correctly', () => {
  // cache miss: 100k * ¥1/M = ¥0.10
  // cache hit:  500k * ¥0.02/M = ¥0.01
  // output:     200k * ¥2/M = ¥0.40
  // total: ¥0.51
  const tokens = { inputTokens: 100000, cacheCreationTokens: 0, cacheReadTokens: 500000, outputTokens: 200000 };
  const result = estimateSessionCost({ model: { display_name: 'deepseek-v4-flash' } }, tokens);
  assert.ok(result);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.inputAmount, 0.1);
  assert.equal(result.cacheReadAmount, 0.01);
  assert.equal(result.outputAmount, 0.4);
  assert.equal(result.totalAmount, 0.51);
});

test('estimateSessionCost matches DeepSeek model from id', () => {
  const tokens = { inputTokens: 1000000, outputTokens: 1000000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { id: 'deepseek-v4-pro' } }, tokens);
  assert.ok(result);
  assert.equal(result.currency, 'CNY');
  // 1M input @ ¥3 + 1M output @ ¥6 = ¥9
  assert.equal(result.totalAmount, 9);
});

test('estimateSessionCost handles legacy deepseek-chat alias', () => {
  const tokens = { inputTokens: 1000000, outputTokens: 1000000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'deepseek-chat' } }, tokens);
  assert.ok(result);
  assert.equal(result.currency, 'CNY');
  // Maps to Flash pricing: 1M @ ¥1 + 1M @ ¥2 = ¥3
  assert.equal(result.totalAmount, 3);
});

test('estimateSessionCost handles legacy deepseek-reasoner alias', () => {
  const tokens = { inputTokens: 1000000, outputTokens: 1000000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'deepseek-reasoner' } }, tokens);
  assert.ok(result);
  assert.equal(result.currency, 'CNY');
  // Maps to Flash pricing: 1M @ ¥1 + 1M @ ¥2 = ¥3
  assert.equal(result.totalAmount, 3);
});

test('DeepSeek estimate includes cache hit discount', () => {
  // All-cache-hit scenario: 1M cache hit tokens, no cache miss, no output
  const tokens = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 1000000, outputTokens: 0 };
  const result = estimateSessionCost({ model: { display_name: 'deepseek-v4-pro' } }, tokens);
  assert.ok(result);
  // 1M cache hit @ ¥0.025/M = ¥0.025
  assert.equal(result.totalAmount, 0.025);
  assert.equal(result.cacheReadAmount, 0.025);
  assert.equal(result.inputAmount, 0);
});

test('DeepSeek ignores native cost and uses CNY estimate', () => {
  // Even when native cost (USD) is available, DeepSeek sessions use the
  // estimate path so the display currency matches DeepSeek's official ¥ pricing.
  const stdin = {
    model: { display_name: 'deepseek-v4-pro' },
    cost: { total_cost_usd: 1.23 },
  };
  const tokens = { inputTokens: 100000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 100000 };
  const result = resolveSessionCost(stdin, tokens);
  assert.ok(result);
  assert.equal(result.source, 'estimate');
  assert.equal(result.currency, 'CNY');
  assert.ok(Math.abs(result.totalAmount - 0.9) < 1e-10); // 100k @ ¥3/M + 100k @ ¥6/M
});

test('DeepSeek estimate fallback when native cost unavailable', () => {
  const stdin = {
    model: { display_name: 'deepseek-v4-pro[1m]' },
  };
  const tokens = { inputTokens: 100000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 100000 };
  const result = resolveSessionCost(stdin, tokens);
  assert.ok(result);
  assert.equal(result.source, 'estimate');
  assert.equal(result.currency, 'CNY');
  // 100k @ ¥3/M + 100k @ ¥6/M = ¥0.3 + ¥0.6 = ¥0.9
  assert.ok(Math.abs(result.totalAmount - 0.9) < 1e-10);
});
