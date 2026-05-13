import type { CharacterCard } from "../cards";

export type ScriptScene = {
  n: number;
  description: string;
  duration_seconds?: number;
};

export type WinningScript = {
  version: string;
  brief: string;
  genre: string;
  logline: string;
  scenes: ScriptScene[];
};

export type CastingResult = {
  characters: CharacterCard[];
};
