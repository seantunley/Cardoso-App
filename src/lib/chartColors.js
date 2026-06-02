// Shared chart colour palette. Recharts needs concrete colour values (it can't
// read CSS custom properties for series strokes/fills), so this is the single
// source of truth for chart colours across pages — import from here rather
// than hardcoding hex values per component.

export const CHART_SERIES = [
  "#60a5fa", // blue
  "#34d399", // green
  "#f59e0b", // amber
  "#f472b6", // pink
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#f87171", // red
  "#4ade80", // lime
];

// Semantic aliases for single-series / positive-vs-negative charts.
export const CHART_PRIMARY = CHART_SERIES[0];  // neutral/primary line
export const CHART_POSITIVE = CHART_SERIES[1]; // good / above-average
export const CHART_WARN = CHART_SERIES[2];     // caution / below-average
