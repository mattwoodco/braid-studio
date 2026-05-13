/**
 * FAL still-image helper. Defaults to Flux schnell (fast + cheap, ~$0.025).
 */
import { fal } from "@fal-ai/client";

const FAL_KEY = process.env.FAL_API_KEY;
if (FAL_KEY) {
  fal.config({ credentials: FAL_KEY });
}

const DEFAULT_MODEL = "fal-ai/flux/schnell";
const FALLBACK_MODEL = "fal-ai/flux/dev";

export type SubmitTextToImageInput = {
  prompt: string;
  model?: string;
  imageSize?: "landscape_16_9" | "portrait_16_9" | "square_hd";
};

export type SubmitTextToImageResult = {
  imageUrl: string;
  modelUsed: string;
};

interface FalImageResult {
  data?: {
    images?: Array<{ url?: string }>;
    image?: { url?: string };
  };
}

function extractImageUrl(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as FalImageResult;
  const first = r.data?.images?.[0]?.url;
  if (first) return first;
  if (r.data?.image?.url) return r.data.image.url;
  return null;
}

export async function submitTextToImage(
  input: SubmitTextToImageInput,
): Promise<SubmitTextToImageResult> {
  const model = input.model ?? DEFAULT_MODEL;
  const imageSize = input.imageSize ?? "landscape_16_9";
  try {
    const result = await fal.subscribe(model, {
      input: { prompt: input.prompt, image_size: imageSize },
      logs: false,
    });
    const url = extractImageUrl(result);
    if (!url) throw new Error(`fal: no image.url from ${model}`);
    return { imageUrl: url, modelUsed: model };
  } catch (err) {
    if (model !== FALLBACK_MODEL) {
      console.warn(
        `[fal-image] ${model} failed (${err instanceof Error ? err.message : String(err)}); falling back to ${FALLBACK_MODEL}`,
      );
      const result = await fal.subscribe(FALLBACK_MODEL, {
        input: { prompt: input.prompt, image_size: imageSize },
        logs: false,
      });
      const url = extractImageUrl(result);
      if (!url) throw new Error(`fal: no image.url from ${FALLBACK_MODEL}`);
      return { imageUrl: url, modelUsed: FALLBACK_MODEL };
    }
    throw err;
  }
}
