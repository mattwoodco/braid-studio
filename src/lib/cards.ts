import { z } from "zod";
import { type MemoryEntry, createMemory, listMemories, updateMemory } from "./anthropic";

export const CharacterCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  age_range: z.string(),
  ethnicity: z.string(),
  height: z.string(),
  build: z.string(),
  hair: z.object({
    length: z.string(),
    color: z.string(),
    texture: z.string(),
  }),
  wardrobe: z.array(
    z.object({
      shot_indices: z.array(z.number()),
      description: z.string(),
    }),
  ),
  speaking_voice: z
    .object({
      tone: z.string(),
      pace: z.string(),
      accent: z.string().optional(),
    })
    .optional(),
  brand_role: z.enum(["hero", "supporting", "non-brand"]),
});

export type CharacterCard = z.infer<typeof CharacterCardSchema>;

export const SettingCardSchema = z.object({
  id: z.string(),
  location_type: z.string(),
  time_of_day: z.string(),
  weather: z.string(),
  lighting: z.object({
    primary_source: z.string(),
    quality: z.enum(["hard", "soft", "diffuse"]),
    color_temp_k: z.number(),
  }),
  palette: z.object({
    dominant: z.array(z.string()),
    accents: z.array(z.string()),
  }),
  practical_elements: z.array(z.string()),
  audio_ambience: z.string(),
});

export type SettingCard = z.infer<typeof SettingCardSchema>;

export const ShotCardSchema = z.object({
  n: z.number().int().min(0),
  characters: z.array(z.string()).min(1),
  setting: z.string(),
  framing: z.enum(["ECU", "CU", "MS", "WS", "EWS"]),
  composition: z.enum([
    "thirds-left",
    "thirds-right",
    "center-intentional",
    "diagonal",
    "negative-space-heavy",
  ]),
  camera_motion: z.enum([
    "static",
    "push-in",
    "pull-out",
    "pan-L",
    "pan-R",
    "dolly",
    "handheld-drift",
  ]),
  duration_seconds: z.number().positive(),
  emotional_beat: z.string(),
  on_screen_text: z.string().optional(),
});

export type ShotCard = z.infer<typeof ShotCardSchema>;

export interface CardsStorage {
  create(
    storeId: string,
    path: string,
    content: string,
  ): Promise<{ id: string; path: string; content: string }>;
  update(
    storeId: string,
    memoryId: string,
    content: string,
  ): Promise<{ id: string; path: string; content: string }>;
  list(storeId: string, prefix?: string): Promise<{ id: string; path: string }[]>;
}

const BIBLE_PREFIX = "/memory/bible/";

function charactersPath(version: string): string {
  return `${BIBLE_PREFIX}characters/${version}.json`;
}

function settingsPath(version: string): string {
  return `${BIBLE_PREFIX}settings/${version}.json`;
}

function shotsPath(version: string): string {
  return `${BIBLE_PREFIX}shots/${version}.json`;
}

const defaultStorage: CardsStorage = {
  async create(storeId, path, content) {
    const entry = await createMemory(storeId, { path, content });
    return { id: entry.id, path: entry.path, content: entry.content };
  },
  async update(storeId, memoryId, content) {
    const entry = await updateMemory(storeId, memoryId, { content });
    return { id: entry.id, path: entry.path, content: entry.content };
  },
  async list(storeId, prefix) {
    const opts: { prefix?: string } = {};
    if (prefix !== undefined) opts.prefix = prefix;
    const entries: MemoryEntry[] = await listMemories(storeId, opts);
    return entries.map((e) => ({ id: e.id, path: e.path }));
  },
};

let _storage: CardsStorage = defaultStorage;

export function setCardsStorage(impl: CardsStorage): void {
  _storage = impl;
}

async function upsert(storeId: string, path: string, content: string): Promise<void> {
  const entries = await _storage.list(storeId, BIBLE_PREFIX);
  const existing = entries.find((e) => e.path === path);
  if (existing) {
    await _storage.update(storeId, existing.id, content);
  } else {
    await _storage.create(storeId, path, content);
  }
}

export async function writeCharacters(
  storeId: string,
  version: string,
  cards: CharacterCard[],
): Promise<void> {
  const parsed = CharacterCardSchema.array().parse(cards);
  await upsert(storeId, charactersPath(version), JSON.stringify(parsed));
}

export async function writeSettings(
  storeId: string,
  version: string,
  cards: SettingCard[],
): Promise<void> {
  const parsed = SettingCardSchema.array().parse(cards);
  await upsert(storeId, settingsPath(version), JSON.stringify(parsed));
}

export async function writeShots(
  storeId: string,
  version: string,
  shots: ShotCard[],
): Promise<void> {
  const parsed = ShotCardSchema.array().parse(shots);
  await upsert(storeId, shotsPath(version), JSON.stringify(parsed));
}
