/**
 * Video backend seam.
 *
 * The draft route used to inline three calls in sequence:
 *   submitTextToVideo  -> composeClips  -> ffprobeDuration
 *
 * Unit 2 extracts that into a swappable `VideoBackend` interface so:
 *   - tests can inject fake generators (no fal/ffmpeg in CI),
 *   - the draft route (Unit 4) calls a single `generateAndCompose` method,
 *   - constrain mode can pre-populate `lockedUrls` to reuse parent shots.
 *
 * The DEFAULT backend wraps the real fal + ffmpeg code. It is constructed
 * lazily so that simply importing this module never touches the network.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

export type GenerateInput = {
  /** One video prompt per shot index. */
  prompts: string[];
  /** Map of shot index -> existing video URL to reuse (skip generation for that index). */
  lockedUrls?: Record<number, string>;
  storeId: string;
  /** Basename (no extension) the caller wants for the composed mp4 (e.g. `draft-<storeId>-<ts>`). */
  outputBasename: string;
};

export type GenerateOutput = {
  /**
   * URLs in shot-index order. Locked entries equal `lockedUrls[i]`.
   * Newly-generated entries are the fresh URLs returned by the generator.
   * Entries may be `null` only if the backend explicitly skipped them (not used
   * by the default backend — composeClips requires all urls non-null).
   */
  shotUrls: (string | null)[];
  mp4LocalPath: string;
  durationSeconds: number;
  fileBytes: number;
  modelUsed: string | null;
};

export interface VideoBackend {
  generateAndCompose(input: GenerateInput): Promise<GenerateOutput>;
}

// ---------- Default backend (real fal + ffmpeg) ----------

/**
 * Lazy default backend. We DO NOT import fal/ffmpeg at module top-level,
 * so importing `video-backend` never triggers fal client config. Tests
 * that inject a fake backend therefore pay zero side-effect cost.
 */
function createDefaultBackend(): VideoBackend {
  return {
    async generateAndCompose(input: GenerateInput): Promise<GenerateOutput> {
      // Dynamic imports keep top-level free of fal/ffmpeg side effects.
      const [{ submitTextToVideo }, { composeClips, ffprobeDuration }] = await Promise.all([
        import("@/lib/fal"),
        import("@/lib/ffmpeg"),
      ]);

      const locked = input.lockedUrls ?? {};

      // Dispatch all open generations CONCURRENTLY (red/green R1).
      type GenSlot = {
        index: number;
        promise: Promise<{ videoUrl: string; modelUsed: string }>;
      };
      const pending: GenSlot[] = [];
      for (let i = 0; i < input.prompts.length; i++) {
        if (Object.prototype.hasOwnProperty.call(locked, i)) continue;
        const prompt = input.prompts[i] ?? "";
        pending.push({ index: i, promise: submitTextToVideo({ prompt }) });
      }
      const settled = await Promise.all(pending.map((p) => p.promise));

      const shotUrls: (string | null)[] = new Array(input.prompts.length).fill(null);
      for (let i = 0; i < input.prompts.length; i++) {
        const lockedUrl = locked[i];
        if (lockedUrl !== undefined) shotUrls[i] = lockedUrl;
      }
      let modelUsed: string | null = null;
      for (let k = 0; k < pending.length; k++) {
        const slot = pending[k];
        const res = settled[k];
        if (slot && res) {
          shotUrls[slot.index] = res.videoUrl;
          if (modelUsed === null) modelUsed = res.modelUsed;
        }
      }

      const composeInput: string[] = [];
      for (let i = 0; i < shotUrls.length; i++) {
        const u = shotUrls[i];
        if (!u) throw new Error(`video-backend: missing url at shot ${i}`);
        composeInput.push(u);
      }

      const runId = randomUUID();
      const scratchDir = `/tmp/braid-studio-${runId}`;
      await mkdir(scratchDir, { recursive: true });
      const scratchOut = `${scratchDir}/final.mp4`;
      await composeClips({ clipUrls: composeInput, outPath: scratchOut });
      const durationSeconds = await ffprobeDuration(scratchOut);

      const finalsDir = resolvePath(process.cwd(), "data/finals");
      await mkdir(finalsDir, { recursive: true });
      const mp4LocalPath = resolvePath(finalsDir, `${input.outputBasename}.mp4`);
      await copyFile(scratchOut, mp4LocalPath);
      const st = await stat(mp4LocalPath);

      // basename is intentionally referenced to keep this module's surface stable
      // for callers that inspect via `basename(out.mp4LocalPath)`.
      void basename;

      return {
        shotUrls,
        mp4LocalPath,
        durationSeconds,
        fileBytes: st.size,
        modelUsed,
      };
    },
  };
}

// ---------- Module-level seam ----------

let _impl: VideoBackend | null = null;

/**
 * Replace the active backend. Pass `null` to restore the default.
 * Tests use this to inject deterministic fakes.
 */
export function setVideoBackend(impl: VideoBackend | null): void {
  _impl = impl;
}

/**
 * Get the active backend (default constructed lazily on first call).
 */
export function getVideoBackend(): VideoBackend {
  if (_impl) return _impl;
  _impl = createDefaultBackend();
  // Mark default as "default" so setVideoBackend(null) followed by getVideoBackend()
  // can return a fresh default — but for our tests we only need that the reference
  // differs from the previously-set fake, which it does (createDefaultBackend
  // returns a new object).
  return _impl;
}
