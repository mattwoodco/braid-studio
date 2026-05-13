import { test, expect, afterEach } from "bun:test";
import {
  animaticDurationSec,
  buildAnimaticFfmpegArgs,
  composeAnimatic,
  setFfmpegRunner,
  type FfmpegRunner,
} from "./animatic";

afterEach(() => {
  setFfmpegRunner(null);
});

test("buildAnimaticFfmpegArgs: requires stills", () => {
  expect(() =>
    buildAnimaticFfmpegArgs({
      stills: [],
      audio: { voPath: "/vo.wav" },
      outPath: "/out.mp4",
    }),
  ).toThrow();
});

test("buildAnimaticFfmpegArgs: minimal stills + VO", () => {
  const args = buildAnimaticFfmpegArgs({
    stills: [
      { path: "/s1.png", durationSec: 2 },
      { path: "/s2.png", durationSec: 3 },
    ],
    audio: { voPath: "/vo.wav" },
    outPath: "/out.mp4",
  });

  const inputs = args.filter((a, i) => args[i - 1] === "-i");
  expect(inputs).toEqual(["/s1.png", "/s2.png", "/vo.wav"]);

  expect(args).toContain("-loop");
  expect(args).toContain("1");
  expect(args[args.length - 1]).toBe("/out.mp4");

  const fcIdx = args.indexOf("-filter_complex");
  expect(fcIdx).toBeGreaterThan(-1);
  const filter = args[fcIdx + 1] ?? "";
  expect(filter).toContain("concat=n=2:v=1:a=0[vout]");
  expect(filter).toContain("scale=1280:720");
  expect(filter).toContain("fps=30");
  expect(filter).toContain("amix=inputs=1");

  expect(args).toContain("libx264");
  expect(args).toContain("aac");
  expect(args).toContain("+faststart");
  expect(args).toContain("-pix_fmt");
  expect(args).toContain("yuv420p");

  const mapIdx = args.indexOf("-map");
  expect(args[mapIdx + 1]).toBe("[vout]");
});

test("buildAnimaticFfmpegArgs: music mixed at -18 LUFS-ish (volume=0.2)", () => {
  const args = buildAnimaticFfmpegArgs({
    stills: [{ path: "/s1.png", durationSec: 2 }],
    audio: { voPath: "/vo.wav", musicPath: "/music.wav" },
    outPath: "/out.mp4",
  });
  const fc = args[args.indexOf("-filter_complex") + 1] ?? "";
  expect(fc).toContain("volume=0.2");
  expect(fc).toContain("[amusic]");
  expect(fc).toContain("amix=inputs=2");

  const inputs = args.filter((_, i) => args[i - 1] === "-i");
  expect(inputs).toEqual(["/s1.png", "/vo.wav", "/music.wav"]);
});

test("buildAnimaticFfmpegArgs: SFX delayed at cumulative still offsets", () => {
  const args = buildAnimaticFfmpegArgs({
    stills: [
      { path: "/s1.png", durationSec: 2 },
      { path: "/s2.png", durationSec: 3 },
      { path: "/s3.png", durationSec: 1.5 },
    ],
    audio: { voPath: "/vo.wav", sfxPaths: ["/sfx1.wav", "/sfx2.wav", "/sfx3.wav"] },
    outPath: "/out.mp4",
  });
  const fc = args[args.indexOf("-filter_complex") + 1] ?? "";
  expect(fc).toContain("adelay=0|0");
  expect(fc).toContain("adelay=2000|2000");
  expect(fc).toContain("adelay=5000|5000");
  expect(fc).toContain("amix=inputs=4");
});

test("buildAnimaticFfmpegArgs: music + sfx combined input ordering", () => {
  const args = buildAnimaticFfmpegArgs({
    stills: [
      { path: "/s1.png", durationSec: 2 },
      { path: "/s2.png", durationSec: 2 },
    ],
    audio: { voPath: "/vo.wav", musicPath: "/m.wav", sfxPaths: ["/sfx1.wav"] },
    outPath: "/out.mp4",
  });
  const inputs = args.filter((_, i) => args[i - 1] === "-i");
  expect(inputs).toEqual(["/s1.png", "/s2.png", "/vo.wav", "/m.wav", "/sfx1.wav"]);
  const fc = args[args.indexOf("-filter_complex") + 1] ?? "";
  expect(fc).toContain("amix=inputs=3");
});

test("buildAnimaticFfmpegArgs: rejects more sfx than stills", () => {
  expect(() =>
    buildAnimaticFfmpegArgs({
      stills: [{ path: "/s1.png", durationSec: 2 }],
      audio: { voPath: "/vo.wav", sfxPaths: ["/a.wav", "/b.wav"] },
      outPath: "/out.mp4",
    }),
  ).toThrow();
});

test("animaticDurationSec: cumulative sum", () => {
  expect(
    animaticDurationSec([
      { path: "/a", durationSec: 2 },
      { path: "/b", durationSec: 3.5 },
    ]),
  ).toBeCloseTo(5.5);
});

test("composeAnimatic: invokes injected runner with built argv", async () => {
  const captured: { cmd: string; args: string[] }[] = [];
  const fakeRunner: FfmpegRunner = async (cmd, args) => {
    captured.push({ cmd, args });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  setFfmpegRunner(fakeRunner);

  const out = `/tmp/animatic-test-${Date.now()}/out.mp4`;
  const res = await composeAnimatic({
    stills: [
      { path: "/s1.png", durationSec: 2 },
      { path: "/s2.png", durationSec: 3 },
    ],
    audio: { voPath: "/vo.wav" },
    outPath: out,
  });
  expect(res.mp4Path).toBe(out);
  expect(res.durationSec).toBeCloseTo(5);
  expect(captured).toHaveLength(1);
  const c = captured[0];
  expect(c?.cmd).toBe("ffmpeg");
  expect(c?.args[c.args.length - 1]).toBe(out);
});

test("composeAnimatic: surfaces runner failure", async () => {
  setFfmpegRunner(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
  await expect(
    composeAnimatic({
      stills: [{ path: "/s1.png", durationSec: 2 }],
      audio: { voPath: "/vo.wav" },
      outPath: `/tmp/animatic-test-fail-${Date.now()}/out.mp4`,
    }),
  ).rejects.toThrow(/boom/);
});
