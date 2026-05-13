import { z } from "zod";
import {
  createMemory,
  listMemories,
  type MemoryEntry,
  updateMemory,
} from "./anthropic";

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
  list(
    storeId: string,
    prefix?: string,
  ): Promise<{ id: string; path: string }[]>;
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

const CHARACTERS_PREFIX = "/memory/bible/characters/";
const SETTINGS_PREFIX = "/memory/bible/settings/";

function characterPath(id: string): string {
  return `${CHARACTERS_PREFIX}${id}.json`;
}

function settingPath(id: string): string {
  return `${SETTINGS_PREFIX}${id}.json`;
}

export async function writeCharacter(
  storeId: string,
  card: CharacterCard,
): Promise<void> {
  const validated = CharacterCardSchema.parse(card);
  const path = characterPath(validated.id);
  const content = JSON.stringify(validated);
  const existing = await _storage.list(storeId, CHARACTERS_PREFIX);
  const hit = existing.find((e) => e.path === path);
  if (hit) {
    await _storage.update(storeId, hit.id, content);
  } else {
    await _storage.create(storeId, path, content);
  }
}

export async function writeSetting(
  storeId: string,
  card: SettingCard,
): Promise<void> {
  const validated = SettingCardSchema.parse(card);
  const path = settingPath(validated.id);
  const content = JSON.stringify(validated);
  const existing = await _storage.list(storeId, SETTINGS_PREFIX);
  const hit = existing.find((e) => e.path === path);
  if (hit) {
    await _storage.update(storeId, hit.id, content);
  } else {
    await _storage.create(storeId, path, content);
  }
}
