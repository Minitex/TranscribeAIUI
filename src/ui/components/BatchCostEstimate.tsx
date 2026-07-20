interface BatchCostEstimateInput {
  fileCount: number;
  quantity: number; // pages (image) or minutes (audio)
  unit: 'page' | 'minute';
  directPricePerUnit: number;
  batchPricePerUnit: number;
}

const format = (v: number) => (v < 0.01 && v > 0 ? '<$0.01' : `$${v.toFixed(2)}`);

export function formatBatchCostEstimate({
  fileCount,
  quantity,
  unit,
  directPricePerUnit,
  batchPricePerUnit
}: BatchCostEstimateInput): string | null {
  if (!fileCount) return null;
  const quantityLabel = unit === 'page'
    ? `~${Math.round(quantity)} page${quantity === 1 ? '' : 's'}`
    : `~${quantity.toFixed(1)} minute${quantity === 1 ? '' : 's'}`;
  const directCost = quantity * directPricePerUnit;
  const batchCost = quantity * batchPricePerUnit;
  const savings = directCost - batchCost;
  const savingsPercent = directPricePerUnit > 0 ? Math.round((1 - batchPricePerUnit / directPricePerUnit) * 100) : 0;
  return `Save ${format(savings)} (${savingsPercent}% off) on ${quantityLabel} across ${fileCount} file${fileCount === 1 ? '' : 's'} — ${format(batchCost)} batch vs ${format(directCost)} direct`;
}

// Appends a live cost estimate (when one is available) below the static explanation,
// so both transcriber panes render the "Batch mode" tooltip identically.
export function buildBatchModeTooltip(explanation: string, estimateInput: BatchCostEstimateInput | null): string {
  const estimate = estimateInput ? formatBatchCostEstimate(estimateInput) : null;
  return estimate ? `${explanation}\n\n${estimate}` : explanation;
}
