import { ReasoningEffort } from "./type";

export const REASONING_EFFORTS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "No Reasoning",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Maximum"
};

export const EFFORT_BUDGETS: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 12288,
  max: 16384
};
