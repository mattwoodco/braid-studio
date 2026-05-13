import { beforeEach, expect, test } from "bun:test";
import type { CardsStorage } from "../cards";
import { setCardsStorage } from "../cards";
import {
  type ProductionDesignClient,
  type WinningScript,
  resetProductionDesignClient,
  runProductionDesign,
  setProductionDesignClient,
} from "./production-design";

type Stored = { id: string; path: string; content: string };

function makeFakeStorage(): {
  storage: CardsStorage;
  entries: Map<string, Stored>;
  calls: { create: number; update: number; list: number };
} {
  const entries = new Map<string, Stored>();
  const calls = { create: 0, update: 0, list: 0 };
  let counter = 0;
  const storage: CardsStorage = {
    async create(storeId, path, content) {
      calls.create++;
      counter++;
      const entry: Stored = { id: `mem_${counter}`, path, content };
      entries.set(`${storeId}::${path}`, entry);
      return entry;
    },
    async update(storeId, memoryId, content) {
      calls.update++;
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          entry.content = content;
          return { id: entry.id, path: entry.path, content };
        }
      }
      throw new Error(`not found: ${memoryId}`);
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
  };
  return { storage, entries, calls };
}

const script: WinningScript = {
  title: "Sample",
  hook: "Hook line.",
  scenes: [
    { description: "Coffee shop morning", duration_seconds: 5 },
    { description: "Park afternoon", duration_seconds: 7 },
  ],
  voiceover_or_dialogue: "VO line.",
  ending_beat: "Logo reveal.",
};

const validSettings = {
  settings: [
    {
      id: "coffee_shop_morning",
      location_type: "coffee_shop",
      time_of_day: "morning",
      weather: "clear",
      lighting: {
        primary_source: "window",
        quality: "soft",
        color_temp_k: 5200,
      },
      palette: {
        dominant: ["warm_brown", "cream"],
        accents: ["copper"],
      },
      practical_elements: ["espresso_machine", "wooden_counter"],
      audio_ambience: "low chatter, steam hiss",
    },
    {
      id: "park_afternoon",
      location_type: "park",
      time_of_day: "afternoon",
      weather: "partly_cloudy",
      lighting: {
        primary_source: "sun",
        quality: "diffuse",
        color_temp_k: 5600,
      },
      palette: {
        dominant: ["green", "sky_blue"],
        accents: ["yellow"],
      },
      practical_elements: ["bench", "fountain"],
      audio_ambience: "birds, distant traffic",
    },
  ],
};

beforeEach(() => {
  resetProductionDesignClient();
});

test("runProductionDesign returns validated SettingCard array", async () => {
  const { storage } = makeFakeStorage();
  setCardsStorage(storage);
  setProductionDesignClient({
    async generate() {
      return validSettings;
    },
  });
  const cards = await runProductionDesign({
    script,
    characters: [],
    brief: "brand brief",
    storeId: "store_1",
  });
  expect(cards).toHaveLength(2);
  expect(cards[0]?.id).toBe("coffee_shop_morning");
  expect(cards[1]?.lighting.color_temp_k).toBe(5600);
});

test("runProductionDesign persists each SettingCard via writeSetting", async () => {
  const fake = makeFakeStorage();
  setCardsStorage(fake.storage);
  setProductionDesignClient({
    async generate() {
      return validSettings;
    },
  });
  await runProductionDesign({
    script,
    characters: [],
    brief: "brand brief",
    storeId: "store_1",
  });
  expect(fake.calls.create).toBe(2);
  expect(fake.entries.size).toBe(2);
  const paths = Array.from(fake.entries.values()).map((e) => e.path);
  expect(paths).toContain("/memory/bible/settings/coffee_shop_morning.json");
  expect(paths).toContain("/memory/bible/settings/park_afternoon.json");
});

test("runProductionDesign throws on schema-violating model output", async () => {
  const { storage } = makeFakeStorage();
  setCardsStorage(storage);
  setProductionDesignClient({
    async generate() {
      return {
        settings: [
          {
            id: "missing_fields",
            location_type: "park",
          },
        ],
      };
    },
  });
  await expect(
    runProductionDesign({
      script,
      characters: [],
      brief: "brand brief",
      storeId: "store_1",
    }),
  ).rejects.toThrow();
});

test("runProductionDesign throws when response shape is wrong", async () => {
  const { storage } = makeFakeStorage();
  setCardsStorage(storage);
  setProductionDesignClient({
    async generate() {
      return { not_settings: [] };
    },
  });
  await expect(
    runProductionDesign({
      script,
      characters: [],
      brief: "brand brief",
      storeId: "store_1",
    }),
  ).rejects.toThrow();
});

test("runProductionDesign forwards script and characters to the client", async () => {
  const { storage } = makeFakeStorage();
  setCardsStorage(storage);
  let captured: unknown = null;
  setProductionDesignClient({
    async generate(input) {
      captured = input;
      return validSettings;
    },
  });
  await runProductionDesign({
    script,
    characters: [],
    brief: "brand brief",
    storeId: "store_1",
  });
  const cap = captured as {
    script: WinningScript;
    brief: string;
    characters: unknown[];
  };
  expect(cap.script.title).toBe("Sample");
  expect(cap.brief).toBe("brand brief");
  expect(cap.characters).toHaveLength(0);
});
