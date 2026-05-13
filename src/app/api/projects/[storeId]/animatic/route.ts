import { NextResponse } from "next/server";
import { z } from "zod";
import { composeAnimatic as defaultComposeAnimatic } from "@/lib/animatic";
import { getAudioBackend as defaultGetAudioBackend } from "@/lib/audio";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  stillUrls: z.array(z.string().min(1)).min(1),
  scriptText: z.string().min(1),
});

export type AudioBackendLike = {
  generateVO: (scriptText: string) => Promise<{ voPath: string }>;
};

export type AnimaticComposerInput = {
  stills: string[];
  audio: { voPath: string };
  outPath: string;
};

export type AnimaticComposerOutput = {
  mp4Path: string;
  durationSec: number;
};

export type AnimaticComposer = (
  input: AnimaticComposerInput,
) => Promise<AnimaticComposerOutput>;

export type GetAudioBackend = () => AudioBackendLike;

let _getAudioBackend: GetAudioBackend = defaultGetAudioBackend;
let _composeAnimatic: AnimaticComposer = defaultComposeAnimatic;

export function setAudioBackendGetter(fn: GetAudioBackend | null): void {
  _getAudioBackend = fn ?? defaultGetAudioBackend;
}

export function setAnimaticComposer(fn: AnimaticComposer | null): void {
  _composeAnimatic = fn ?? defaultComposeAnimatic;
}

function tsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 500 },
    );
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: `invalid_body: ${parsed.error.message}` },
      { status: 500 },
    );
  }

  try {
    const { stillUrls, scriptText } = parsed.data;
    const audio = await _getAudioBackend().generateVO(scriptText);
    const outPath = `/tmp/animatic-${storeId}-${tsStamp()}.mp4`;
    const result = await _composeAnimatic({
      stills: stillUrls,
      audio: { voPath: audio.voPath },
      outPath,
    });
    return NextResponse.json({
      ok: true,
      mp4Path: result.mp4Path,
      durationSec: result.durationSec,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
