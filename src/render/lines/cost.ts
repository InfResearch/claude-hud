import type { RenderContext } from '../../types.js';
import { resolveSessionCost, formatCost } from '../../cost.js';
import { t } from '../../i18n/index.js';
import { label } from '../colors.js';

export function renderCostEstimate(ctx: RenderContext): string | null {
  if (ctx.config?.display?.showCost !== true) {
    return null;
  }

  const cost = resolveSessionCost(ctx.stdin, ctx.transcript.sessionTokens);
  if (!cost) {
    return null;
  }

  const labelKey = cost.source === 'native' ? 'label.cost' : 'label.estimatedCost';
  return label(`${t(labelKey)} ${formatCost(cost.totalAmount, cost.currency)}`, ctx.config?.colors);
}
