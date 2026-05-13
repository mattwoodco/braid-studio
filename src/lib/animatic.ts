export type ComposeAnimaticInput = {
  stills: string[];
  audio: { voPath: string };
  outPath: string;
};

export type ComposeAnimaticOutput = {
  mp4Path: string;
  durationSec: number;
};

export async function composeAnimatic(
  _input: ComposeAnimaticInput,
): Promise<ComposeAnimaticOutput> {
  throw new Error("composeAnimatic not implemented");
}
