import type { SessionTokenUsage, StdinData } from './types.js';
import { isBedrockModelId, isVertexModelId } from './stdin.js';

type ModelPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

type DeepSeekPricing = {
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
  cacheHitCnyPerMillion: number;
};

export type Currency = 'USD' | 'CNY';

export interface SessionCostEstimate {
  totalAmount: number;
  currency: Currency;
  inputAmount: number;
  cacheCreationAmount: number;
  cacheReadAmount: number;
  outputAmount: number;
}

export interface SessionCostDisplay {
  totalAmount: number;
  currency: Currency;
  source: 'native' | 'estimate';
}

const TOKENS_PER_MILLION = 1_000_000;
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Patterns are tried in order; the first match wins. Families with more specific
// model lines (Haiku 4.x differs from Haiku 3.5) must come before any broader
// fallback patterns to avoid silent under-pricing.
const ANTHROPIC_MODEL_PRICING: Array<{ pattern: RegExp; pricing: ModelPricing }> = [
  { pattern: /\bopus 4 (?:[5-9]|\d{2,})\b/i, pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } },
  { pattern: /\bopus 4(?: \d+)?\b/i, pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 } },
  { pattern: /\bsonnet 4(?: \d+)?\b/i, pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { pattern: /\bsonnet 3 7\b/i, pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { pattern: /\bsonnet 3 5\b/i, pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { pattern: /\bhaiku 4(?: \d+)?\b/i, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 } },
  { pattern: /\bhaiku 3 5\b/i, pricing: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 } },
  // Enterprise plan aliases (e.g. opusplan, sonnetplan, haikuplan)
  { pattern: /\bopusplan\b/i, pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 } },
  { pattern: /\bsonnetplan\b/i, pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { pattern: /\bhaikuplan\b/i, pricing: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 } },
];

// DeepSeek pricing in CNY per 1M tokens.
// DeepSeek has a fundamentally different caching model from Anthropic:
//   - cache MISS (input_tokens) → full input price
//   - cache HIT  (cache_read_input_tokens) → heavily discounted price
//   - No separate cache-creation billing (cache_creation_input_tokens is always 0).
//
// When Claude Code maps DeepSeek usage into Anthropic-style fields:
//   input_tokens              ← prompt_cache_miss_tokens  (not cached)
//   cache_read_input_tokens   ← prompt_cache_hit_tokens   (cache hits)
//   cache_creation_input_tokens ← 0
const DEEPSEEK_MODEL_PRICING: Array<{ pattern: RegExp; pricing: DeepSeekPricing }> = [
  // Patterns use spaces because normalizeModelName replaces hyphens/underscores with spaces.
  { pattern: /\bdeepseek v4 pro\b/i,   pricing: { inputCnyPerMillion: 3, outputCnyPerMillion: 6, cacheHitCnyPerMillion: 0.025 } },
  { pattern: /\bdeepseek v4 flash\b/i,  pricing: { inputCnyPerMillion: 1, outputCnyPerMillion: 2, cacheHitCnyPerMillion: 0.02 } },
  // Legacy model name aliases (deprecated 2026/07/24, map to Flash)
  { pattern: /\bdeepseek chat\b/i,      pricing: { inputCnyPerMillion: 1, outputCnyPerMillion: 2, cacheHitCnyPerMillion: 0.02 } },
  { pattern: /\bdeepseek reasoner\b/i,  pricing: { inputCnyPerMillion: 1, outputCnyPerMillion: 2, cacheHitCnyPerMillion: 0.02 } },
];

function normalizeModelName(modelName: string): string {
  return modelName
    .toLowerCase()
    .replace(/^claude\s+/, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAnthropicPricing(modelName: string): ModelPricing | null {
  const normalized = normalizeModelName(modelName);
  for (const entry of ANTHROPIC_MODEL_PRICING) {
    if (entry.pattern.test(normalized)) {
      return entry.pricing;
    }
  }
  return null;
}

export function isDeepSeekModelId(modelId?: string): boolean {
  if (!modelId) {
    return false;
  }
  return /deepseek/i.test(modelId);
}

function matchDeepSeekPricing(modelName: string): DeepSeekPricing | null {
  const normalized = normalizeModelName(modelName);
  for (const entry of DEEPSEEK_MODEL_PRICING) {
    if (entry.pattern.test(normalized)) {
      return entry.pricing;
    }
  }
  return null;
}

function calculateAmount(tokens: number, amountPerMillion: number): number {
  return (tokens * amountPerMillion) / TOKENS_PER_MILLION;
}

function getAnthropicPricing(stdin: StdinData): ModelPricing | null {
  const candidates = [
    stdin.model?.display_name?.trim(),
    stdin.model?.id?.trim(),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const pricing = matchAnthropicPricing(candidate);
    if (pricing) {
      return pricing;
    }
  }

  return null;
}

function getDeepSeekPricing(stdin: StdinData): DeepSeekPricing | null {
  const candidates = [
    stdin.model?.display_name?.trim(),
    stdin.model?.id?.trim(),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const pricing = matchDeepSeekPricing(candidate);
    if (pricing) {
      return pricing;
    }
  }

  return null;
}

function estimateDeepSeekSessionCost(
  sessionTokens: SessionTokenUsage,
  pricing: DeepSeekPricing,
): SessionCostEstimate | null {
  const totalTokens = sessionTokens.inputTokens
    + sessionTokens.cacheReadTokens
    + sessionTokens.outputTokens;
  if (totalTokens === 0) {
    return null;
  }

  // DeepSeek token semantics (as mapped by Claude Code into Anthropic fields):
  //   input_tokens              = cache MISS (full input price)
  //   cache_read_input_tokens   = cache HIT  (discounted cache price)
  //   cache_creation_input_tokens = 0 (no separate creation billing)
  const inputAmount = calculateAmount(sessionTokens.inputTokens, pricing.inputCnyPerMillion);
  const cacheReadAmount = calculateAmount(sessionTokens.cacheReadTokens, pricing.cacheHitCnyPerMillion);
  const outputAmount = calculateAmount(sessionTokens.outputTokens, pricing.outputCnyPerMillion);

  return {
    totalAmount: inputAmount + cacheReadAmount + outputAmount,
    currency: 'CNY',
    inputAmount,
    cacheCreationAmount: 0,
    cacheReadAmount,
    outputAmount,
  };
}

function estimateAnthropicSessionCost(
  sessionTokens: SessionTokenUsage,
  pricing: ModelPricing,
): SessionCostEstimate | null {
  const totalTokens = sessionTokens.inputTokens
    + sessionTokens.cacheCreationTokens
    + sessionTokens.cacheReadTokens
    + sessionTokens.outputTokens;
  if (totalTokens === 0) {
    return null;
  }

  // Anthropic token semantics:
  //   input_tokens              = ALL input (includes both cached and uncached)
  //   cache_creation_input_tokens = new cache entries (1.25× input price)
  //   cache_read_input_tokens   = cache hits (0.1× input price)
  const inputAmount = calculateAmount(sessionTokens.inputTokens, pricing.inputUsdPerMillion);
  const cacheCreationAmount = calculateAmount(sessionTokens.cacheCreationTokens, pricing.inputUsdPerMillion * CACHE_WRITE_MULTIPLIER);
  const cacheReadAmount = calculateAmount(sessionTokens.cacheReadTokens, pricing.inputUsdPerMillion * CACHE_READ_MULTIPLIER);
  const outputAmount = calculateAmount(sessionTokens.outputTokens, pricing.outputUsdPerMillion);

  return {
    totalAmount: inputAmount + cacheCreationAmount + cacheReadAmount + outputAmount,
    currency: 'USD',
    inputAmount,
    cacheCreationAmount,
    cacheReadAmount,
    outputAmount,
  };
}

export function estimateSessionCost(
  stdin: StdinData,
  sessionTokens: SessionTokenUsage | undefined,
): SessionCostEstimate | null {
  if (!sessionTokens) {
    return null;
  }

  if (isBedrockModelId(stdin.model?.id)) {
    return null;
  }

  if (isVertexModelId(stdin.model?.id)) {
    return null;
  }

  const totalTokens = sessionTokens.inputTokens
    + sessionTokens.cacheCreationTokens
    + sessionTokens.cacheReadTokens
    + sessionTokens.outputTokens;
  if (totalTokens === 0) {
    return null;
  }

  // Try DeepSeek pricing first (more specific match)
  const deepSeekPricing = getDeepSeekPricing(stdin);
  if (deepSeekPricing) {
    return estimateDeepSeekSessionCost(sessionTokens, deepSeekPricing);
  }

  // Fall back to Anthropic pricing
  const anthropicPricing = getAnthropicPricing(stdin);
  if (anthropicPricing) {
    return estimateAnthropicSessionCost(sessionTokens, anthropicPricing);
  }

  return null;
}

function getNativeCostUsd(stdin: StdinData): number | null {
  const nativeCost = stdin.cost?.total_cost_usd;
  if (typeof nativeCost !== 'number' || !Number.isFinite(nativeCost)) {
    return null;
  }

  if (isBedrockModelId(stdin.model?.id)) {
    return null;
  }

  if (isVertexModelId(stdin.model?.id)) {
    return null;
  }

  return nativeCost;
}

export function resolveSessionCost(
  stdin: StdinData,
  sessionTokens: SessionTokenUsage | undefined,
): SessionCostDisplay | null {
  // DeepSeek: always use the estimate path so currency is ¥ (CNY).
  // Claude Code's native cost is always in USD regardless of provider,
  // but DeepSeek's official pricing is denominated in CNY.
  if (isDeepSeekModelId(stdin.model?.id) || isDeepSeekModelId(stdin.model?.display_name)) {
    const estimate = estimateSessionCost(stdin, sessionTokens);
    if (estimate) {
      return {
        totalAmount: estimate.totalAmount,
        currency: estimate.currency,
        source: 'estimate',
      };
    }
    return null;
  }

  // Anthropic / other providers: prefer native cost (USD).
  const nativeCostUsd = getNativeCostUsd(stdin);
  if (nativeCostUsd !== null) {
    return {
      totalAmount: nativeCostUsd,
      currency: 'USD',
      source: 'native',
    };
  }

  const estimate = estimateSessionCost(stdin, sessionTokens);
  if (!estimate) {
    return null;
  }

  return {
    totalAmount: estimate.totalAmount,
    currency: estimate.currency,
    source: 'estimate',
  };
}

export function formatCost(amount: number, currency: Currency): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (amount >= 1) {
    return `${symbol}${amount.toFixed(2)}`;
  }
  if (amount >= 0.1) {
    return `${symbol}${amount.toFixed(3)}`;
  }
  return `${symbol}${amount.toFixed(4)}`;
}

/** @deprecated Use formatCost(amount, 'USD') instead. */
export function formatUsd(amount: number): string {
  return formatCost(amount, 'USD');
}
