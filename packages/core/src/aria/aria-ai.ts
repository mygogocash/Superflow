import { HttpException } from "../http-exception.js";

export type AriaAiEnv = {
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
};

export function hasAiKeys(env: AriaAiEnv = {}) {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.GEMINI_API_KEY?.trim());
}

export async function streamChat(
  _input: unknown,
  _env: AriaAiEnv,
): Promise<Response> {
  if (!hasAiKeys(_env)) {
    throw new HttpException(
      501,
      "NOT_IMPLEMENTED",
      "Manut AI chat streaming is not configured on edge (missing AI API keys)",
    );
  }
  const mod = await import("./aria-ai-runtime.js");
  return mod.streamChat(_input, _env);
}
