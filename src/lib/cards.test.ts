import { beforeEach, expect, test } from "bun:test";
import {
  type CardsStorage,
  type CharacterCard,
  CharacterCardSchema,
  readBible,
  type SettingCard,
  SettingCardSchema,
  setCardsStorage,
  type ShotCard,
  ShotCardSchema,
  writeCharacter,
  writeSetting,
  writeShots,
} from "./cards";

type StoredEntry = { id: string; path: string; content: string };

function makeFakeStorage() {
  const entries = new Map<string, StoredEntry>();
  const calls = { create: 0, update: 0, list: 0, read: 0 };
  let idCounter = 0;
  const storage: CardsStorage = {
    async create(storeId, path, content) {
      calls.create++;
      const key = `${storeId}::${path}`;
      if (entries.has(key)) throw new Error(`exists: ${path}`);
      idCounter++;
      const entry: StoredEntry = { id: `mem_${idCounter}`, path, content };
      entries.set(key, entry);
      return entry;
    },
    async update(storeId, memoryId, content) {
      calls.update++;
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          entry.content = content;
          return entry;
        }
      }
      throw new Error("not found");
    },
    async list(storeId, prefix) {
      calls.list++;
      const out: { id: string; path: string }[] = [];
      for (const [key, entry] of entries) {
        if (!key.startsWith(`${storeId}::`)) continue;
        if (prefix && !entry.path.startsWith(prefix)) continue;
        out.push({ id: entry.id, path: entry.path });
      }
      return out;
    },
    async read(storeId, memoryId) {
      calls.read++;
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          return entry;
        }
      }
      throw new Error("not found");
    },
  };
  return { storage, entries, calls };
}

function makeCharacter(id: string): CharacterCard {
  return {
    id,
    name: `Char ${id}`,
    age_range: "30-40",
    ethnicity: "unspecified",
    height: "5'10\"",
    build: "athletic",
    hair: { length: "short", color: "black", texture: "straight" },
    wardrobe: [
      { shot_indices: [0, 1], description: "navy suit" },
      { shot_indices: [2], description: "casual tee" },
    ],
    speaking_voice: { tone: "warm", pace: "measured" },
    brand_role: "hero",
  };
}

function makeSetting(id: string): SettingCard {
  return {
    id,
    location_type: "rooftop",
    time_of_day: "golden hour",
    weather: "clear",
    lighting: {
      primary_source: "sun",
      quality: "soft",
      color_temp_k: 3200,
    },
    palette: {
      dominant: ["amber", "navy"],
      accents: ["white"],
    },
    practical_elements: ["string lights"],
    audio_ambience: "distant traffic",
  };
}

function makeShot(n: number): ShotCard {
  return {
    n,
    characters: ["c1"],
    setting: "s1",
    framing: "MS",
    composition: "thirds-left",
    camera_motion: "static",
    duration_seconds: 3,
    emotional_beat: "anticipation",
  };
}

let fake: ReturnType<typeof makeFakeStorage>;
const STORE = "store_1";

beforeEach(() => {
  fake = makeFakeStorage();
  setCardsStorage(fake.storage);
});

test("CharacterCardSchema rejects missing required fields", () => {
  const bad = { id: "c1", name: "x" };
  expect(CharacterCardSchema.safeParse(bad).success).toBe(false);
});

test("CharacterCardSchema rejects invalid brand_role", () => {
  const c = makeCharacter("c1") as unknown as Record<string, unknown>;
  c.brand_role = "villain";
  expect(CharacterCardSchema.safeParse(c).success).toBe(false);
});

test("CharacterCardSchema rejects negative shot_indices", () => {
  const c = makeCharacter("c1");
  c.wardrobe[0]!.shot_indices = [-1];
  expect(CharacterCardSchema.safeParse(c).success).toBe(false);
});

test("SettingCardSchema rejects invalid lighting quality", () => {
  const s = makeSetting("s1") as unknown as Record<string, unknown> & {
    lighting: { quality: string };
  };
  s.lighting.quality = "fluorescent";
  expect(SettingCardSchema.safeParse(s).success).toBe(false);
});

test("SettingCardSchema rejects non-positive color_temp_k", () => {
  const s = makeSetting("s1");
  s.lighting.color_temp_k = 0;
  expect(SettingCardSchema.safeParse(s).success).toBe(false);
});

test("ShotCardSchema rejects invalid framing", () => {
  const sh = makeShot(0) as unknown as Record<string, unknown>;
  sh.framing = "BIG";
  expect(ShotCardSchema.safeParse(sh).success).toBe(false);
});

test("ShotCardSchema rejects zero duration", () => {
  const sh = makeShot(0);
  sh.duration_seconds = 0;
  expect(ShotCardSchema.safeParse(sh).success).toBe(false);
});

test("ShotCardSchema accepts optional on_screen_text", () => {
  const sh = makeShot(0);
  sh.on_screen_text = "BUY NOW";
  expect(ShotCardSchema.safeParse(sh).success).toBe(true);
});

test("writeCharacter writes to /bible/characters/{id}.json", async () => {
  const c = makeCharacter("c1");
  await writeCharacter(STORE, c);
  const stored = fake.entries.get(`${STORE}::/bible/characters/c1.json`);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored?.content ?? "")).toEqual(c);
});

test("writeCharacter upserts existing character", async () => {
  const c = makeCharacter("c1");
  await writeCharacter(STORE, c);
  const creates1 = fake.calls.create;
  const c2 = { ...c, name: "Renamed" };
  await writeCharacter(STORE, c2);
  expect(fake.calls.create).toBe(creates1);
  expect(fake.calls.update).toBe(1);
  const stored = fake.entries.get(`${STORE}::/bible/characters/c1.json`);
  expect(JSON.parse(stored?.content ?? "").name).toBe("Renamed");
});

test("writeSetting writes to /bible/settings/{id}.json", async () => {
  const s = makeSetting("s1");
  await writeSetting(STORE, s);
  const stored = fake.entries.get(`${STORE}::/bible/settings/s1.json`);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored?.content ?? "")).toEqual(s);
});

test("writeShots writes to /bible/shots/v{N}.json", async () => {
  const shots = [makeShot(0), makeShot(1)];
  await writeShots(STORE, "v1", shots);
  const stored = fake.entries.get(`${STORE}::/bible/shots/v1.json`);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored?.content ?? "")).toEqual(shots);
});

test("writeShots rejects malformed shots", async () => {
  const bad = [{ n: 0 } as unknown as ShotCard];
  await expect(writeShots(STORE, "v1", bad)).rejects.toThrow();
});

test("readBible round-trips characters, settings, and latest shots", async () => {
  await writeCharacter(STORE, makeCharacter("c1"));
  await writeCharacter(STORE, makeCharacter("c2"));
  await writeSetting(STORE, makeSetting("s1"));
  await writeShots(STORE, "v1", [makeShot(0)]);
  await writeShots(STORE, "v2", [makeShot(0), makeShot(1)]);

  const bible = await readBible(STORE);
  expect(bible.characters.map((c) => c.id)).toEqual(["c1", "c2"]);
  expect(bible.settings.map((s) => s.id)).toEqual(["s1"]);
  expect(bible.shots.length).toBe(2);
  expect(bible.shots.map((s) => s.n)).toEqual([0, 1]);
});

test("readBible picks highest numeric shot version", async () => {
  await writeShots(STORE, "v1", [makeShot(0)]);
  await writeShots(STORE, "v10", [makeShot(0), makeShot(1), makeShot(2)]);
  await writeShots(STORE, "v2", [makeShot(0), makeShot(1)]);
  const bible = await readBible(STORE);
  expect(bible.shots.length).toBe(3);
});

test("readBible skips malformed entries silently", async () => {
  await writeCharacter(STORE, makeCharacter("c1"));
  await fake.storage.create(STORE, "/bible/characters/bad.json", "{not json");
  await fake.storage.create(
    STORE,
    "/bible/characters/wrongshape.json",
    JSON.stringify({ id: "x" }),
  );
  const bible = await readBible(STORE);
  expect(bible.characters.map((c) => c.id)).toEqual(["c1"]);
});

test("readBible returns empty arrays when nothing stored", async () => {
  const bible = await readBible(STORE);
  expect(bible).toEqual({ characters: [], settings: [], shots: [] });
});
