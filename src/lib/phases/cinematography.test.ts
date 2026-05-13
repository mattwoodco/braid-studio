import { beforeEach, expect, test } from "bun:test";
import type { CharacterCard, SettingCard, ShotCard } from "../cards";
import type { WinningScript } from "./casting";
import {
  type CinematographyClient,
  type ShotsWriter,
  resetCinematographyClient,
  resetShotsWriter,
  runCinematography,
  setCinematographyClient,
  setShotsWriter,
} from "./cinematography";

type WriteCall = { storeId: string; version: string; shots: ShotCard[] };

function makeRecordingWriter(): {
  writer: ShotsWriter;
  calls: WriteCall[];
} {
  const calls: WriteCall[] = [];
  const writer: ShotsWriter = async (storeId, version, shots) => {
    calls.push({ storeId, version, shots });
  };
  return { writer, calls };
}

function makeStubClient(payload: string): {
  client: CinematographyClient;
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  const client: CinematographyClient = {
    async generate({ system, user }) {
      calls.push({ system, user });
      return payload;
    },
  };
  return { client, calls };
}

const HERO: CharacterCard = {
  id: "hero",
  name: "Mira",
  age_range: "20s",
  ethnicity: "South Asian",
  height: "5'7\"",
  build: "athletic",
  hair: { length: "shoulder", color: "black", texture: "wavy" },
  wardrobe: [{ shot_indices: [0, 1, 2], description: "red hoodie, dark jeans" }],
  brand_role: "hero",
};

const FRIEND: CharacterCard = {
  id: "friend",
  name: "Jay",
  age_range: "20s",
  ethnicity: "Black",
  height: "6'0\"",
  build: "lean",
  hair: { length: "short", color: "black", texture: "coiled" },
  wardrobe: [{ shot_indices: [1, 2], description: "denim jacket, white tee" }],
  brand_role: "supporting",
};

const ROOFTOP: SettingCard = {
  id: "rooftop",
  location_type: "urban rooftop",
  time_of_day: "magic hour",
  weather: "clear",
  lighting: { primary_source: "sun", quality: "soft", color_temp_k: 4200 },
  palette: { dominant: ["amber", "indigo"], accents: ["red"] },
  practical_elements: ["string lights"],
  audio_ambience: "distant traffic",
};

const SCRIPT: WinningScript = {
  version: "v1",
  brief: "energy drink for night owls",
  genre: "ugc",
  logline: "two friends share a moment on a rooftop",
  scenes: [
    { n: 0, description: "Mira opens can", duration_seconds: 3 },
    { n: 1, description: "Jay arrives", duration_seconds: 3 },
    { n: 2, description: "cheers on rooftop", duration_seconds: 4 },
  ],
};

const VALID_SHOTS: ShotCard[] = [
  {
    n: 0,
    characters: ["hero"],
    setting: "rooftop",
    framing: "CU",
    composition: "thirds-left",
    camera_motion: "push-in",
    duration_seconds: 3,
    emotional_beat: "anticipation",
  },
  {
    n: 1,
    characters: ["hero", "friend"],
    setting: "rooftop",
    framing: "MS",
    composition: "diagonal",
    camera_motion: "pan-R",
    duration_seconds: 3,
    emotional_beat: "reunion",
  },
  {
    n: 2,
    characters: ["hero", "friend"],
    setting: "rooftop",
    framing: "WS",
    composition: "negative-space-heavy",
    camera_motion: "pull-out",
    duration_seconds: 4,
    emotional_beat: "celebration",
    on_screen_text: "stay sharp",
  },
];

const BASE_INPUT = {
  script: SCRIPT,
  characters: [HERO, FRIEND],
  settings: [ROOFTOP],
  brief: "energy drink for night owls",
  storeId: "store_test_123",
};

beforeEach(() => {
  resetCinematographyClient();
  resetShotsWriter();
});

test("runCinematography parses shots, validates schema, and persists via writeShots", async () => {
  const payload = JSON.stringify({ shots: VALID_SHOTS });
  const { client } = makeStubClient(payload);
  setCinematographyClient(client);
  const { writer, calls } = makeRecordingWriter();
  setShotsWriter(writer);

  const out = await runCinematography(BASE_INPUT);

  expect(out).toHaveLength(3);
  expect(out[0]?.n).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.storeId).toBe("store_test_123");
  expect(calls[0]?.version).toBe("v1");
  expect(calls[0]?.shots).toHaveLength(3);
});

test("runCinematography tolerates fenced JSON in model response", async () => {
  const payload = `\`\`\`json\n${JSON.stringify({ shots: VALID_SHOTS })}\n\`\`\``;
  const { client } = makeStubClient(payload);
  setCinematographyClient(client);
  const { writer, calls } = makeRecordingWriter();
  setShotsWriter(writer);

  const out = await runCinematography(BASE_INPUT);
  expect(out).toHaveLength(3);
  expect(calls).toHaveLength(1);
});

test("runCinematography throws when a shot references a dangling character id", async () => {
  const bad = [
    {
      ...VALID_SHOTS[0],
      characters: ["ghost"],
    },
    VALID_SHOTS[1],
    VALID_SHOTS[2],
  ];
  const { client } = makeStubClient(JSON.stringify({ shots: bad }));
  setCinematographyClient(client);
  const { writer, calls } = makeRecordingWriter();
  setShotsWriter(writer);

  await expect(runCinematography(BASE_INPUT)).rejects.toThrow(/unknown character id/);
  expect(calls).toHaveLength(0);
});

test("runCinematography throws when a shot references a dangling setting id", async () => {
  const bad = [VALID_SHOTS[0], { ...VALID_SHOTS[1], setting: "nowhere" }, VALID_SHOTS[2]];
  const { client } = makeStubClient(JSON.stringify({ shots: bad }));
  setCinematographyClient(client);
  const { writer, calls } = makeRecordingWriter();
  setShotsWriter(writer);

  await expect(runCinematography(BASE_INPUT)).rejects.toThrow(/unknown setting id/);
  expect(calls).toHaveLength(0);
});

test("runCinematography rejects responses missing the shots field", async () => {
  const { client } = makeStubClient(JSON.stringify({ other: [] }));
  setCinematographyClient(client);
  const { writer, calls } = makeRecordingWriter();
  setShotsWriter(writer);

  await expect(runCinematography(BASE_INPUT)).rejects.toThrow(/shots/);
  expect(calls).toHaveLength(0);
});

test("runCinematography rejects shots that fail schema validation", async () => {
  const malformed = [
    {
      n: 0,
      characters: ["hero"],
      setting: "rooftop",
      framing: "BOGUS",
      composition: "thirds-left",
      camera_motion: "static",
      duration_seconds: 3,
      emotional_beat: "x",
    },
  ];
  const { client } = makeStubClient(JSON.stringify({ shots: malformed }));
  setCinematographyClient(client);
  const { writer, calls } = makeRecordingWriter();
  setShotsWriter(writer);

  await expect(runCinematography(BASE_INPUT)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("runCinematography sends system + user prompt with rule-of-thirds guidance", async () => {
  const { client, calls: clientCalls } = makeStubClient(JSON.stringify({ shots: VALID_SHOTS }));
  setCinematographyClient(client);
  const { writer } = makeRecordingWriter();
  setShotsWriter(writer);

  await runCinematography(BASE_INPUT);
  expect(clientCalls).toHaveLength(1);
  expect(clientCalls[0]?.system).toMatch(/cinematographer/i);
  expect(clientCalls[0]?.system).toMatch(/rule_of_thirds/);
  expect(clientCalls[0]?.user).toMatch(/BRIEF/);
  expect(clientCalls[0]?.user).toContain("hero");
  expect(clientCalls[0]?.user).toContain("rooftop");
});
