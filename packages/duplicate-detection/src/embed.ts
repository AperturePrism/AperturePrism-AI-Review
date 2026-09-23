/** Dimension returned by nvidia/nemotron-3-embed-1b (symmetric, no additional params). */
export const EMBEDDING_DIMENSION = 1024;
export const EMBEDDING_MODEL = "text-embedding-3-small" as const;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export type EmbedInput = {
  baseUrl: string;
  apiKey: string;
  /** Model name; defaults to cf-free text-embedding-3-small (BGE-M3, 1024-d). */
  model?: string;
  texts: readonly string[];
  fetchImpl?: typeof fetch;
};

export type EmbeddingResponse = {
  /** One vector per input text, all length EMBEDDING_DIMENSION. */
  vectors: number[][];
  usage: { promptTokens: number; totalTokens: number };
};

/**
 * Calls an OpenAI-compatible `/embeddings` endpoint. nemotron-3-embed-1b is
 * symmetric and needs no extra request params beyond `{ model, input }`.
 */
export async function embedTexts(
  input: EmbedInput,
): Promise<EmbeddingResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, "");
  const model = input.model ?? EMBEDDING_MODEL;
  const response = await fetchImpl(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({ model, input: input.texts }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new EmbeddingError(
      `embeddings responded with ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await response.json()) as {
    data?: { embedding?: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const vectors = (body.data ?? []).map((item) => item.embedding ?? []);
  if (vectors.some((v) => v.length !== EMBEDDING_DIMENSION)) {
    throw new EmbeddingError(
      `embedding dimension mismatch (expected ${EMBEDDING_DIMENSION})`,
    );
  }
  return {
    vectors,
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      totalTokens: body.usage?.total_tokens ?? 0,
    },
  };
}

/** Convenience for a single text. */
export async function embedOne(
  input: Omit<EmbedInput, "texts"> & { text: string },
) {
  const { text, ...rest } = input;
  const result = await embedTexts({ ...rest, texts: [text] });
  return { vector: result.vectors[0] ?? [], usage: result.usage };
}
