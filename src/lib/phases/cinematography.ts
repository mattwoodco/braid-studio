import {
  type CharacterCard,
  type SettingCard,
  type ShotCard,
  ShotCardSchema,
  writeShots as defaultWriteShots,
} from "../cards";
import { anth } from "../claude-judge";
import type { WinningScript } from "./casting";

const CINEMATOGRAPHY_MODEL = "claude-sonnet-4-5";
const CINEMATOGRAPHY_VERSION = "v1";

export type CinematographyClient = {
  generate(args: {
    system: string;
    user: string;
  }): Promise<string>;
};

const defaultClient: CinematographyClient = {
  async generate({ system, user }) {
    const msg = await anth().messages.create({
      model: CINEMATOGRAPHY_MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    });
    const block = msg.content[0];
    if (!block || block.type !== "text") {
      throw new Error("cinematography: empty model response");
    }
    return block.text;
  },
};

let _client: CinematographyClient = defaultClient;

export function setCinematographyClient(impl: CinematographyClient): void {
  _client = impl;
}

export function resetCinematographyClient(): void {
  _client = defaultClient;
}

export type ShotsWriter = (storeId: string, version: string, shots: ShotCard[]) => Promise<void>;

let _writeShots: ShotsWriter = defaultWriteShots;

export function setShotsWriter(impl: ShotsWriter): void {
  _writeShots = impl;
}

export function resetShotsWriter(): void {
  _writeShots = defaultWriteShots;
}

const SYSTEM_PROMPT = [
  "You are a cinematographer. Convert the script + characters + settings into a numbered ShotCard sequence.",
  "Every shot must reference at least one character id and one setting id.",
  "Vary framing/composition/camera_motion to avoid monotony (per craft rubric: rule_of_thirds is the top discriminator).",
  "Emit `{shots: ShotCard[]}`.",
].join(" ");

function buildUserPrompt(input: {
  script: WinningScript;
  characters: CharacterCard[];
  settings: SettingCard[];
  brief: string;
}): string {
  return [
    `BRIEF: ${input.brief}`,
    "",
    "SCRIPT:",
    JSON.stringify(input.script, null, 2),
    "",
    "CHARACTERS:",
    JSON.stringify(input.characters, null, 2),
    "",
    "SETTINGS:",
    JSON.stringify(input.settings, null, 2),
    "",
    "Allowed framing: ECU | CU | MS | WS | EWS.",
    "Allowed composition: thirds-left | thirds-right | center-intentional | diagonal | negative-space-heavy.",
    "Allowed camera_motion: static | push-in | pull-out | pan-L | pan-R | dolly | handheld-drift.",
    "",
    'Return strict JSON only, shape: {"shots": ShotCard[]}. No prose, no code fences.',
  ].join("\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("cinematography: model response did not contain JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function assertReferentialIntegrity(
  shots: ShotCard[],
  characters: CharacterCard[],
  settings: SettingCard[],
): void {
  const charIds = new Set(characters.map((c) => c.id));
  const setIds = new Set(settings.map((s) => s.id));
  for (const shot of shots) {
    if (!setIds.has(shot.setting)) {
      throw new Error(
        `cinematography: shot ${shot.n} references unknown setting id "${shot.setting}"`,
      );
    }
    for (const cid of shot.characters) {
      if (!charIds.has(cid)) {
        throw new Error(`cinematography: shot ${shot.n} references unknown character id "${cid}"`);
      }
    }
  }
}

export async function runCinematography(input: {
  script: WinningScript;
  characters: CharacterCard[];
  settings: SettingCard[];
  brief: string;
  storeId: string;
}): Promise<ShotCard[]> {
  const text = await _client.generate({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input),
  });
  const raw = extractJson(text);
  if (typeof raw !== "object" || raw === null || !("shots" in raw)) {
    throw new Error("cinematography: response missing `shots` field");
  }
  const shotsRaw = (raw as { shots: unknown }).shots;
  const shots = ShotCardSchema.array().parse(shotsRaw);
  assertReferentialIntegrity(shots, input.characters, input.settings);
  await _writeShots(input.storeId, CINEMATOGRAPHY_VERSION, shots);
  return shots;
}
