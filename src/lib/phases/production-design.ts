import { z } from "zod";
import {
  type CharacterCard,
  type SettingCard,
  SettingCardSchema,
  writeSetting,
} from "../cards";
import { getAnthropic } from "../anthropic";

export type WinningScript = {
  title: string;
  hook: string;
  scenes: { description: string; duration_seconds: number }[];
  voiceover_or_dialogue: string;
  ending_beat: string;
};

export interface ProductionDesignClient {
  generate(input: {
    script: WinningScript;
    characters: CharacterCard[];
    brief: string;
  }): Promise<unknown>;
}

const PROMPT = `You are a production designer. Read script + characters and emit \`{settings: SettingCard[]}\` — one per distinct location/time/weather combination. Required fields: id, location_type, time_of_day, weather, lighting{primary_source,quality,color_temp_k}, palette{dominant[],accents[]}, practical_elements[], audio_ambience.`;

const MODEL = "claude-sonnet-4-5";

const defaultClient: ProductionDesignClient = {
  async generate(input) {
    const anthropic = getAnthropic();
    const userContent = JSON.stringify({
      brief: input.brief,
      script: input.script,
      characters: input.characters,
    });
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: PROMPT,
      messages: [{ role: "user", content: userContent }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("production-design: no text block in response");
    }
    return JSON.parse(extractJson(block.text));
  },
};

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

let _client: ProductionDesignClient = defaultClient;

export function setProductionDesignClient(impl: ProductionDesignClient): void {
  _client = impl;
}

export function resetProductionDesignClient(): void {
  _client = defaultClient;
}

const ResponseSchema = z.object({
  settings: SettingCardSchema.array(),
});

export async function runProductionDesign(input: {
  script: WinningScript;
  characters: CharacterCard[];
  brief: string;
  storeId: string;
}): Promise<SettingCard[]> {
  const raw = await _client.generate({
    script: input.script,
    characters: input.characters,
    brief: input.brief,
  });
  const parsed = ResponseSchema.parse(raw);
  const cards = parsed.settings;
  for (const card of cards) {
    await writeSetting(input.storeId, card);
  }
  return cards;
}
