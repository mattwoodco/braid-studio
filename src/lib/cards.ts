import { z } from "zod";
import {
  createMemory,
  listMemories,
  type MemoryEntry,
  updateMemory,
} from "./anthropic";
import type { DraftsStorage } from "./drafts";

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
      shot_indices: z.array(z.number().int().nonnegative()),
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

export const SettingCardSchema = z.object({
  id: z.string(),
  location_type: z.string(),
  time_of_day: z.string(),
  weather: z.string(),
  lighting: z.object({
    primary_source: z.string(),
    quality: z.enum(["hard", "soft", "diffuse"]),
    color_temp_k: z.number().int().positive(),
  }),
  palette: z.object({
    dominant: z.array(z.string()),
    accents: z.array(z.string()),
  }),
  practical_elements: z.array(z.string()),
  audio_ambience: z.string(),
});

export const ShotCardSchema = z.object({
  n: z.number().int().nonnegative(),
  characters: z.array(z.string()),
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

export type CharacterCard = z.infer<typeof CharacterCardSchema>;
export type SettingCard = z.infer<typeof SettingCardSchema>;
export type ShotCard = z.infer<typeof ShotCardSchema>;

export type CardsStorage = DraftsStorage;

const BIBLE_PREFIX = "/bible/";
const CHARACTERS_PREFIX = "/bible/characters/";
const SETTINGS_PREFIX = "/bible/settings/";
const SHOTS_PREFIX = "/bible/shots/";

const CHARACTER_PATH_RE = /^\/bible\/characters\/([^/]+)\.json$/;
const SETTING_PATH_RE = /^\/bible\/settings\/([^/]+)\.json$/;
const SHOTS_PATH_RE = /^\/bible\/shots\/v(\d+)\.json$/;

function characterPath(id: string): string {
  return `${CHARACTERS_PREFIX}${id}.json`;
}
function settingPath(id: string): string {
  return `${SETTINGS_PREFIX}${id}.json`;
}
function shotsPath(version: string): string {
  return `${SHOTS_PREFIX}${version}.json`;
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
  async read(storeId, memoryId) {
    const entries = await listMemories(storeId, { prefix: BIBLE_PREFIX });
    const hit = entries.find((e) => e.id === memoryId);
    if (!hit) throw new Error(`cards.read: not found: ${memoryId}`);
    return { id: hit.id, path: hit.path, content: hit.content };
  },
};

let _storage: CardsStorage = defaultStorage;

export function setCardsStorage(impl: CardsStorage): void {
  _storage = impl;
}

async function upsert(
  storeId: string,
  path: string,
  content: string,
  prefix: string,
): Promise<void> {
  const entries = await _storage.list(storeId, prefix);
  const existing = entries.find((e) => e.path === path);
  if (existing) {
    await _storage.update(storeId, existing.id, content);
  } else {
    await _storage.create(storeId, path, content);
  }
}

export async function writeCharacter(
  storeId: string,
  card: CharacterCard,
): Promise<void> {
  const parsed = CharacterCardSchema.parse(card);
  await upsert(
    storeId,
    characterPath(parsed.id),
    JSON.stringify(parsed),
    CHARACTERS_PREFIX,
  );
}

export async function writeSetting(
  storeId: string,
  card: SettingCard,
): Promise<void> {
  const parsed = SettingCardSchema.parse(card);
  await upsert(
    storeId,
    settingPath(parsed.id),
    JSON.stringify(parsed),
    SETTINGS_PREFIX,
  );
}

export async function writeShots(
  storeId: string,
  version: string,
  shots: ShotCard[],
): Promise<void> {
  const parsed = z.array(ShotCardSchema).parse(shots);
  await upsert(
    storeId,
    shotsPath(version),
    JSON.stringify(parsed),
    SHOTS_PREFIX,
  );
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readBible(storeId: string): Promise<{
  characters: CharacterCard[];
  settings: SettingCard[];
  shots: ShotCard[];
}> {
  const entries = await _storage.list(storeId, BIBLE_PREFIX);
  const characters: CharacterCard[] = [];
  const settings: SettingCard[] = [];
  const shotsByVersion: { n: number; cards: ShotCard[] }[] = [];

  for (const e of entries) {
    let content: string;
    try {
      const read = await _storage.read(storeId, e.id);
      content = read.content;
    } catch {
      continue;
    }
    const raw = safeParseJson(content);
    if (raw === null) continue;

    if (CHARACTER_PATH_RE.test(e.path)) {
      const p = CharacterCardSchema.safeParse(raw);
      if (p.success) characters.push(p.data);
      continue;
    }
    if (SETTING_PATH_RE.test(e.path)) {
      const p = SettingCardSchema.safeParse(raw);
      if (p.success) settings.push(p.data);
      continue;
    }
    const sm = SHOTS_PATH_RE.exec(e.path);
    if (sm?.[1]) {
      const p = z.array(ShotCardSchema).safeParse(raw);
      if (p.success) {
        shotsByVersion.push({ n: Number.parseInt(sm[1], 10), cards: p.data });
      }
    }
  }

  characters.sort((a, b) => a.id.localeCompare(b.id));
  settings.sort((a, b) => a.id.localeCompare(b.id));
  shotsByVersion.sort((a, b) => b.n - a.n);
  const shots = shotsByVersion[0]?.cards ?? [];

  return { characters, settings, shots };
}
