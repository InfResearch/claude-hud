import type { RenderContext, SessionTokenUsage } from '../../types.js';
import { label, dim } from '../colors.js';
import { t } from '../../i18n/index.js';
import { formatTokens } from '../../utils/format.js';
import { formatCost, isDeepSeekModelId } from '../../cost.js';

function estimateSingleModelCost(
  tokens: SessionTokenUsage,
  modelName: string,
): { amount: number; currency: 'USD' | 'CNY' } | null {
  if (!isDeepSeekModelId(modelName)) {
    return null;
  }

  const normalized = modelName.toLowerCase();
  const isPro = /\bdeepseek.v4.pro\b/i.test(normalized);
  const inputPrice = isPro ? 3 : 1;
  const outputPrice = isPro ? 6 : 2;
  const cacheHitPrice = isPro ? 0.025 : 0.02;

  const TOKENS_PER_MILLION = 1_000_000;
  const inputCny = (tokens.inputTokens * inputPrice) / TOKENS_PER_MILLION;
  const cacheReadCny = (tokens.cacheReadTokens * cacheHitPrice) / TOKENS_PER_MILLION;
  const outputCny = (tokens.outputTokens * outputPrice) / TOKENS_PER_MILLION;

  return { amount: inputCny + cacheReadCny + outputCny, currency: 'CNY' };
}

function formatModelTokenEntry(
  modelName: string,
  tokens: SessionTokenUsage,
): string {
  const parts: string[] = [];

  if (tokens.cacheReadTokens > 0) {
    parts.push(`${t('format.cache')}:${formatTokens(tokens.cacheReadTokens)}`);
  }
  if (tokens.inputTokens > 0) {
    parts.push(`${t('format.in')}:${formatTokens(tokens.inputTokens)}`);
  }
  if (tokens.outputTokens > 0) {
    parts.push(`${t('format.out')}:${formatTokens(tokens.outputTokens)}`);
  }

  let entry = `${modelName} ${parts.join(' ')}`;

  const cost = estimateSingleModelCost(tokens, modelName);
  if (cost) {
    entry += ` ${dim(formatCost(cost.amount, cost.currency))}`;
  }

  return entry;
}

const SKIP_MODEL_PATTERNS = [
  /^<synthetic>$/i,
  /^synthetic$/i,
  /^unknown$/i,
  /^$/,
];

function isIgnoredModel(name: string): boolean {
  return SKIP_MODEL_PATTERNS.some((p) => p.test(name));
}

export function renderSessionTokensLine(ctx: RenderContext): string | null {
  const display = ctx.config?.display;
  if (display?.showSessionTokens === false) {
    return null;
  }

  const modelTokens = ctx.transcript.modelTokens;
  const tokens = ctx.transcript.sessionTokens;
  if (!tokens) {
    return null;
  }

  const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (total === 0) {
    return null;
  }

  const colors = ctx.config?.colors;

  // Per-model breakdown
  if (modelTokens && Object.keys(modelTokens).length > 0) {
    const entries = Object.entries(modelTokens)
      .filter(([model]) => !isIgnoredModel(model))
      .sort(([, a], [, b]) => {
        const aTotal = a.inputTokens + a.outputTokens + a.cacheReadTokens;
        const bTotal = b.inputTokens + b.outputTokens + b.cacheReadTokens;
        return bTotal - aTotal;
      })
      .map(([model, tok]) => formatModelTokenEntry(model, tok));

    if (entries.length === 0) {
      return null;
    }

    return label(entries.join(' │ '), colors);
  }

  // Fallback: compact global format (shouldn't normally be reached)
  const parts: string[] = [];
  if (tokens.cacheReadTokens > 0) {
    parts.push(`${t('format.cache')}:${formatTokens(tokens.cacheReadTokens)}`);
  }
  if (tokens.inputTokens > 0) {
    parts.push(`${t('format.in')}:${formatTokens(tokens.inputTokens)}`);
  }
  if (tokens.outputTokens > 0) {
    parts.push(`${t('format.out')}:${formatTokens(tokens.outputTokens)}`);
  }

  return label(`${t('label.tokens')} ${formatTokens(total)} (${parts.join(', ')})`, colors);
}
