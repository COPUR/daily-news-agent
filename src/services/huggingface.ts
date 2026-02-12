import axios from "axios";

type InferenceProviderMap = Record<string, { status?: string }>;

function modelInfoEndpoint(modelId: string): string {
  return `https://huggingface.co/api/models/${modelId}?expand=inferenceProviderMapping`;
}

function inferenceFallbackEndpoint(modelId: string): string {
  return `https://router.huggingface.co/hf-inference/models/${modelId}`;
}

function providerChatEndpoint(provider: string): string {
  return `https://router.huggingface.co/${encodeURIComponent(provider)}/v1/chat/completions`;
}

function normalizeError(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.detail;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    return JSON.stringify(record);
  }
  return String(value ?? "");
}

export function extractHuggingFaceGeneratedText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    const first = data[0];
    if (typeof first === "string") {
      return first;
    }
    if (first && typeof first === "object" && "generated_text" in first) {
      const generated = (first as { generated_text?: unknown }).generated_text;
      if (typeof generated === "string") {
        return generated;
      }
    }
  }

  if (data && typeof data === "object" && "generated_text" in (data as Record<string, unknown>)) {
    const generated = (data as { generated_text?: unknown }).generated_text;
    if (typeof generated === "string") {
      return generated;
    }
  }

  if (data && typeof data === "object" && "error" in (data as Record<string, unknown>)) {
    throw new Error(normalizeError((data as { error?: unknown }).error));
  }

  return String(data ?? "");
}

function extractChatCompletionContent(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || !choices.length) {
    return null;
  }

  const first = choices[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  return null;
}

async function resolveProviderForModel(modelId: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await axios.get(modelInfoEndpoint(modelId), { timeout: timeoutMs });
    const mapping = (response.data?.inferenceProviderMapping || {}) as InferenceProviderMap;
    const providers = Object.entries(mapping)
      .filter(([, info]) => String(info?.status || "").toLowerCase() === "live")
      .map(([provider]) => provider);
    return providers[0] || null;
  } catch {
    return null;
  }
}

export async function runHuggingFacePrompt(args: {
  apiKey: string;
  modelId: string;
  prompt: string;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const headers = {
    Authorization: `Bearer ${args.apiKey}`,
    "Content-Type": "application/json",
  };
  const temperature = typeof args.temperature === "number" ? args.temperature : 0.2;
  const maxTokens = typeof args.maxTokens === "number" ? args.maxTokens : 1400;

  const provider = await resolveProviderForModel(args.modelId, args.timeoutMs);
  if (provider) {
    try {
      const response = await axios.post(
        providerChatEndpoint(provider),
        {
          model: args.modelId,
          messages: [{ role: "user", content: args.prompt }],
          temperature,
          max_tokens: maxTokens,
        },
        { timeout: args.timeoutMs, headers },
      );
      const content = extractChatCompletionContent(response.data);
      if (content && content.trim()) {
        return content;
      }
      throw new Error("empty chat completion response");
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const detail = normalizeError(error.response?.data || error.message);
        throw new Error(detail || "unknown provider chat completion error");
      }
      throw error;
    }
  }

  try {
    const response = await axios.post(
      inferenceFallbackEndpoint(args.modelId),
      {
        inputs: args.prompt,
        parameters: {
          temperature,
          max_new_tokens: maxTokens,
          return_full_text: false,
        },
        options: {
          wait_for_model: true,
        },
      },
      { timeout: args.timeoutMs, headers },
    );
    return extractHuggingFaceGeneratedText(response.data);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const detail = normalizeError(error.response?.data || error.message);
      throw new Error(detail || "unknown hf-inference error");
    }
    throw error;
  }
}
