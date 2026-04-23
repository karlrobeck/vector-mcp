import { pipeline } from "@huggingface/transformers";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2"; 

let extractor: any = null;

/**
 * Generates a vector embedding for the given text using a Hugging Face model.
 * @param text The string to embed.
 * @returns A promise that resolves to a number array representing the embedding.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME, {
      device: "cpu",
    });
  }

  const output = await extractor(text, { 
    pooling: "mean", 
    normalize: true 
  });

  return Array.from(output.data);
}
