import { config } from "../../config";

export const extractConfig = {
  RERANKING: {
    MAX_INITIAL_RANKING_LIMIT: 1000,
    MAX_RANKING_LIMIT_FOR_RELEVANCE: 100,
    INITIAL_SCORE_THRESHOLD_FOR_RELEVANCE: 0.00000001,
    FALLBACK_SCORE_THRESHOLD_FOR_RELEVANCE: 0.00000001,
    MIN_REQUIRED_LINKS: 1,
  },
  DEDUPLICATION: {
    MAX_TOKENS: 4096,
  },
  MODEL: config.MODEL_NAME ?? "gpt-4o-mini",
  SCHEMA_ANALYSIS_MODEL: config.MODEL_NAME ?? "gpt-4.1",
  PROVIDER: config.OLLAMA_BASE_URL ? "ollama" : "openai",
} as const;
export const CUSTOM_U_TEAMS = ["874d40cc-a5c0-4e93-b661-9ddfbad5e51e"];
