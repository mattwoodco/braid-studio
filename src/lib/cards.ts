import { z } from "zod";
import { createMemory } from "./anthropic";

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

export interface CardsStorage {
  create(
    storeId: string,
    path: string,
    content: string,
  ): Promise<{ id: string; path: string; content: string }>;
}

const defaultCardsStorage: CardsStorage = {
  async create(storeId, path, content) {
    const entry = await createMemory(storeId, { path, content });
    return { id: entry.id, path: entry.path, content: entry.content };
  },
};

let _cardsStorage: CardsStorage = defaultCardsStorage;

export function setCardsStorage(impl: CardsStorage): void {
  _cardsStorage = impl;
}

export async function writeCharacter(
  storeId: string,
  card: CharacterCard,
): Promise<void> {
  const path = `/memory/bible/characters/${card.id}.json`;
  await _cardsStorage.create(storeId, path, JSON.stringify(card, null, 2));
}
