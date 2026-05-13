export type AudioBackend = {
  generateVO: (scriptText: string) => Promise<{ voPath: string }>;
};

const defaultBackend: AudioBackend = {
  async generateVO(_scriptText: string): Promise<{ voPath: string }> {
    throw new Error("audio backend not configured");
  },
};

let _backend: AudioBackend = defaultBackend;

export function setAudioBackend(b: AudioBackend | null): void {
  _backend = b ?? defaultBackend;
}

export function getAudioBackend(): AudioBackend {
  return _backend;
}
