import type { ModelOption } from "./types";

/** Snapshot of the T3 Code model catalog. Refresh from orchestrator_capabilities when it changes. */
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const MODELS: ModelOption[] = [
  { provider: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { provider: "claudeAgent", model: "claude-fable-5-1", label: "Fable 5.1", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { provider: "claudeAgent", model: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { provider: "claudeAgent", model: "claude-haiku-5-5", label: "Haiku 5.5", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { provider: "claudeAgent", model: "claude-opus-5", label: "Opus 5", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { provider: "claudeAgent", model: "claude-sonnet-5", label: "Sonnet 5", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-6-astra", label: "GPT-6 Astra", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-6-sol", label: "GPT-6 Sol", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-6-luna", label: "GPT-6 Luna", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { provider: "codex", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: CODEX_EFFORTS, defaultEffort: "high" },
];

export const DEFAULT_BROADCASTER = { provider: "claudeAgent", model: "claude-opus-5-5", effort: "high" };
/** Who plans the replay video when a game has no broadcaster to do it (or a plan is redone). */
export const DEFAULT_DIRECTOR = DEFAULT_BROADCASTER;

export const modelLabel = (model: string) => MODELS.find((m) => m.model === model)?.label ?? model;

/** Who makes each provider's models, with their brand colour (for the model tags). */
const MAKERS: Record<string, { name: string; color: string }> = {
  claudeAgent: { name: "Claude", color: "#d97757" },
  codex: { name: "OpenAI", color: "#10a37f" },
  human: { name: "Human", color: "#5d9bd5" },
};
export const makerOf = (provider: string) => MAKERS[provider] ?? { name: provider, color: "#8b8987" };
