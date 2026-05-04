/**
 * voyage.ts — Embed a search query via Voyage-3.5-lite from the Worker.
 *
 * Uses input_type: "query" (asymmetric retrieval — corpus was embedded
 * with input_type: "document" by phase-embed.ts on grimmauldplace).
 */

const VOYAGE_MODEL = "voyage-3.5-lite";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export async function embedQuery(
  text: string,
  apiKey: string,
): Promise<Float32Array> {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: "query",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage API ${res.status}: ${body}`);
  }

  const resp = (await res.json()) as VoyageResponse;
  return new Float32Array(resp.data[0].embedding);
}
