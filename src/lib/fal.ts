/**
 * Tiny fal wrapper for the Draft lane.
 * Uses fal.subscribe so the caller awaits one promise per shot.
 */
import { fal } from "@fal-ai/client";

const FAL_KEY = process.env.FAL_API_KEY;
if (FAL_KEY) {
  fal.config({ credentials: FAL_KEY });
}

const DEFAULT_MODEL = "fal-ai/ltx-2.3/text-to-video/fast";
const FALLBACK_MODEL = "fal-ai/wan/v2.2-5b/text-to-video";

export type SubmitTextToVideoInput = {
  prompt: string;
  model?: string;
};

export type SubmitTextToVideoResult = {
  videoUrl: string;
  modelUsed: string;
};

interface FalVideoResult {
  data?: {
    video?: { url?: string };
    url?: string;
  };
}

function extractUrl(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as FalVideoResult;
  if (r.data?.video?.url) return r.data.video.url;
  if (r.data?.url) return r.data.url;
  return null;
}

export async function submitTextToVideo(
  input: SubmitTextToVideoInput,
): Promise<SubmitTextToVideoResult> {
  const model = input.model ?? DEFAULT_MODEL;
  try {
    const result = await fal.subscribe(model, {
      input: { prompt: input.prompt },
      logs: false,
    });
    const url = extractUrl(result);
    if (!url) throw new Error(`fal: no video.url in result from ${model}`);
    return { videoUrl: url, modelUsed: model };
  } catch (err) {
    if (model !== FALLBACK_MODEL) {
      console.warn(
        `[fal] ${model} failed (${err instanceof Error ? err.message : String(err)}); falling back to ${FALLBACK_MODEL}`,
      );
      const result = await fal.subscribe(FALLBACK_MODEL, {
        input: { prompt: input.prompt },
        logs: false,
      });
      const url = extractUrl(result);
      if (!url) throw new Error(`fal: no video.url in result from ${FALLBACK_MODEL}`);
      return { videoUrl: url, modelUsed: FALLBACK_MODEL };
    }
    throw err;
  }
}
