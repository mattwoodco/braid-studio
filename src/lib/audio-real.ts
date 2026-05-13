import type { AudioBackend } from "@/lib/audio";
import { localStubBackend } from "@/lib/audio";

function createRealBackend(): AudioBackend {
  return {
    generateVO(text, voiceId) {
      if (!process.env.ELEVENLABS_API_KEY) return localStubBackend.generateVO(text, voiceId);
      return import("@/lib/audio-elevenlabs").then((m) =>
        m.elevenlabsBackend.generateVO!(text, voiceId),
      );
    },
    generateSFX(text, durationSeconds) {
      if (!process.env.ELEVENLABS_API_KEY) return localStubBackend.generateSFX(text, durationSeconds);
      return import("@/lib/audio-elevenlabs").then((m) =>
        m.elevenlabsBackend.generateSFX!(text, durationSeconds),
      );
    },
    generateMusic(prompt) {
      if (!process.env.SUNO_API_KEY) return localStubBackend.generateMusic(prompt);
      return import("@/lib/audio-suno").then((m) => m.sunoBackend.generateMusic(prompt));
    },
  };
}

export const realBackend: AudioBackend = createRealBackend();
