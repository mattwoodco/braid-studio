import { z } from "zod";
import { getAnthropic } from "../anthropic";
import {
  type CharacterCard,
  CharacterCardSchema,
  writeCharacter,
} from "../cards";

export type WinningScript = {
  title: string;
  hook: string;
  scenes: { description: string; duration_seconds: number }[];
  voiceover_or_dialogue: string;
  ending_beat: string;
};

const CASTING_MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = [
  "You are a casting director.",
  "Read the provided ad script and identify every character that appears in 2 or more scenes.",
  "Emit ONLY a JSON object with shape {\"characters\": CharacterCard[]}.",
  "Each CharacterCard requires: id (kebab-case), name, age_range, ethnicity, height, build,",
  "hair {length, color, texture}, wardrobe [{shot_indices, description}], brand_role",
  "(one of \"hero\", \"supporting\", \"non-brand\"). Optional: speaking_voice {tone, pace, accent?}.",
  "Return strict JSON — no prose, no markdown fences.",
].join("\n");

const ResponseSchema = z.object({
  characters: CharacterCardSchema.array(),
});

export type MessagesCreate = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
}) => Promise<{ content: { type: string; text?: string }[] }>;

let _messagesCreate: MessagesCreate | null = null;

export function setCastingMessagesCreate(fn: MessagesCreate | null): void {
  _messagesCreate = fn;
}

function getCreator(): MessagesCreate {
  if (_messagesCreate) return _messagesCreate;
  const client = getAnthropic();
  return async (params) => {
    const msg = await client.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.messages,
    });
    return { content: msg.content };
  };
}

function extractText(blocks: { type: string; text?: string }[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("").trim();
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

export async function runCasting(input: {
  script: WinningScript;
  brief: string;
  storeId: string;
}): Promise<CharacterCard[]> {
  const creator = getCreator();
  const userPrompt = [
    `BRIEF: ${input.brief}`,
    "",
    "SCRIPT:",
    JSON.stringify(input.script, null, 2),
    "",
    "Return strict JSON: {\"characters\": CharacterCard[]}",
  ].join("\n");

  const msg = await creator({
    model: CASTING_MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const raw = extractText(msg.content);
  const json = JSON.parse(stripFences(raw)) as unknown;
  const parsed = ResponseSchema.parse(json);
  const characters = parsed.characters;

  await Promise.all(
    characters.map((card) => writeCharacter(input.storeId, card)),
  );
  return characters;
}
