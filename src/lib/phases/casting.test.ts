import { beforeEach, describe, expect, test } from "bun:test";
import {
  type CardsStorage,
  type CharacterCard,
  setCardsStorage,
} from "../cards";
import {
  type MessagesCreate,
  type WinningScript,
  runCasting,
  setCastingMessagesCreate,
} from "./casting";

type Stored = { storeId: string; path: string; content: string };

function makeFakeCards(): { storage: CardsStorage; entries: Stored[] } {
  const entries: Stored[] = [];
  let counter = 0;
  const storage: CardsStorage = {
    async create(storeId, path, content) {
      counter++;
      entries.push({ storeId, path, content });
      return { id: `mem_${counter}`, path, content };
    },
  };
  return { storage, entries };
}

function makeScript(): WinningScript {
  return {
    title: "Mug Shot",
    hook: "Two friends discover better coffee",
    scenes: [
      { description: "Anna pours coffee at home", duration_seconds: 3 },
      { description: "Ben tastes and reacts", duration_seconds: 3 },
      { description: "Anna and Ben toast cups", duration_seconds: 4 },
    ],
    voiceover_or_dialogue: "Anna: 'Try this.' Ben: 'Whoa.'",
    ending_beat: "Logo over steaming cup",
  };
}

const FIXTURE_CHARACTERS: CharacterCard[] = [
  {
    id: "anna",
    name: "Anna",
    age_range: "28-32",
    ethnicity: "Latina",
    height: "5'6\"",
    build: "athletic",
    hair: { length: "shoulder", color: "dark brown", texture: "wavy" },
    wardrobe: [
      { shot_indices: [0, 2], description: "cream linen shirt, jeans" },
    ],
    brand_role: "hero",
  },
  {
    id: "ben",
    name: "Ben",
    age_range: "28-32",
    ethnicity: "Black",
    height: "6'0\"",
    build: "lean",
    hair: { length: "short", color: "black", texture: "coily" },
    wardrobe: [
      { shot_indices: [1, 2], description: "navy henley, chinos" },
    ],
    brand_role: "supporting",
  },
];

function makeAnthropicMock(payload: unknown): { create: MessagesCreate; calls: { params: Parameters<MessagesCreate>[0] }[] } {
  const calls: { params: Parameters<MessagesCreate>[0] }[] = [];
  const create: MessagesCreate = async (params) => {
    calls.push({ params });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  };
  return { create, calls };
}

let cards: ReturnType<typeof makeFakeCards>;

beforeEach(() => {
  cards = makeFakeCards();
  setCardsStorage(cards.storage);
  setCastingMessagesCreate(null);
});

describe("runCasting", () => {
  test("returns validated CharacterCard[] from Anthropic JSON response", async () => {
    const mock = makeAnthropicMock({ characters: FIXTURE_CHARACTERS });
    setCastingMessagesCreate(mock.create);

    const result = await runCasting({
      script: makeScript(),
      brief: "Coffee for two",
      storeId: "store_x",
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("anna");
    expect(result[1]?.brand_role).toBe("supporting");
  });

  test("persists each character to the bible path", async () => {
    const mock = makeAnthropicMock({ characters: FIXTURE_CHARACTERS });
    setCastingMessagesCreate(mock.create);

    await runCasting({
      script: makeScript(),
      brief: "b",
      storeId: "store_y",
    });

    expect(cards.entries).toHaveLength(2);
    expect(cards.entries[0]?.path).toBe(
      "/memory/bible/characters/anna.json",
    );
    expect(cards.entries[1]?.path).toBe(
      "/memory/bible/characters/ben.json",
    );
    expect(cards.entries[0]?.storeId).toBe("store_y");
    const parsed = JSON.parse(cards.entries[0]?.content ?? "{}");
    expect(parsed.name).toBe("Anna");
  });

  test("strips markdown code fences from model output", async () => {
    const fenced: MessagesCreate = async () => ({
      content: [
        {
          type: "text",
          text: "```json\n" +
            JSON.stringify({ characters: FIXTURE_CHARACTERS }) +
            "\n```",
        },
      ],
    });
    setCastingMessagesCreate(fenced);

    const result = await runCasting({
      script: makeScript(),
      brief: "b",
      storeId: "store_z",
    });
    expect(result).toHaveLength(2);
  });

  test("throws when payload fails schema validation", async () => {
    const bad: MessagesCreate = async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            characters: [{ id: "x", name: "X" }],
          }),
        },
      ],
    });
    setCastingMessagesCreate(bad);

    await expect(
      runCasting({ script: makeScript(), brief: "b", storeId: "s" }),
    ).rejects.toThrow();
  });

  test("calls Sonnet 4.5 model with a system prompt and the script", async () => {
    const mock = makeAnthropicMock({ characters: FIXTURE_CHARACTERS });
    setCastingMessagesCreate(mock.create);

    await runCasting({
      script: makeScript(),
      brief: "Coffee for two",
      storeId: "store_x",
    });

    expect(mock.calls).toHaveLength(1);
    const params = mock.calls[0]?.params;
    expect(params?.model).toBe("claude-sonnet-4-5");
    expect(params?.system.toLowerCase()).toContain("casting director");
    expect(params?.messages[0]?.content).toContain("Mug Shot");
  });
});
