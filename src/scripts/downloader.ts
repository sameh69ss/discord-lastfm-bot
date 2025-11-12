// src/downloader.ts

let ffmpeg: any;
import ffmpegPath from "ffmpeg-static";

const ffprobeStatic: any = require("ffprobe-static");
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import fetch from "node-fetch";
import cp from "child_process";


let resolvedFfmpeg: string | undefined;
let resolvedFfprobe: string | undefined;
try {
  
  const envFfmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG;
  const envFfprobe = process.env.FFPROBE_PATH || process.env.FFPROBE;

  
  const pkgFfmpeg = (ffmpegPath as any)?.path ?? (ffmpegPath as any);
  const pkgFfprobe = (ffprobeStatic as any)?.path ?? (ffprobeStatic as any);

  resolvedFfmpeg = envFfmpeg ?? (pkgFfmpeg as string);
  resolvedFfprobe = envFfprobe ?? (pkgFfprobe as string);
  
  const candidateFfmpegPaths = [
    String(process.env.FFMPEG_PATH || ""),
    "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\tools\\ffmpeg\\ffmpeg.exe",
  ].filter(Boolean) as string[];
  const candidateFfprobePaths = [
    String(process.env.FFPROBE_PATH || ""),
    "C:\\tools\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\tools\\ffmpeg\\ffprobe.exe",
  ].filter(Boolean) as string[];
  if (!resolvedFfmpeg) {
    for (const p of candidateFfmpegPaths) {
      try {
        if (fs.existsSync(p)) {
          resolvedFfmpeg = p;
          console.log(`[downloader] located local ffmpeg at ${p}`);
          break;
        }
      } catch {}
    }
  }
  if (!resolvedFfprobe) {
    for (const p of candidateFfprobePaths) {
      try {
        if (fs.existsSync(p)) {
          resolvedFfprobe = p;
          console.log(`[downloader] located local ffprobe at ${p}`);
          break;
        }
      } catch {}
    }
  }
  
  try {
    console.log(`[downloader] resolved ffmpeg => ${resolvedFfmpeg} (env override: ${envFfmpeg ? 'yes' : 'no'})`);
    console.log(`[downloader] resolved ffprobe => ${resolvedFfprobe} (env override: ${envFfprobe ? 'yes' : 'no'})`);
    try {
      const statFfmpeg = fs.statSync(resolvedFfmpeg as string);
      console.log(`[downloader] ffmpeg stat: size=${statFfmpeg.size} mode=${statFfmpeg.mode}`);
    } catch (err) {
      console.log(`[downloader] ffmpeg stat failed: ${(err as any).message}`);
    }
    try {
      const statFfprobe = fs.statSync(resolvedFfprobe as string);
      console.log(`[downloader] ffprobe stat: size=${statFfprobe.size} mode=${statFfprobe.mode}`);
    } catch (err) {
      console.log(`[downloader] ffprobe stat failed: ${(err as any).message}`);
    }
  } catch (_) {}

  try {
    if (resolvedFfmpeg) process.env.FFMPEG_PATH = resolvedFfmpeg;
    if (resolvedFfprobe) process.env.FFPROBE_PATH = resolvedFfprobe;

    
    try {

      ffmpeg = require("fluent-ffmpeg");
    } catch (err) {
      console.log(`[downloader] failed to require fluent-ffmpeg: ${(err as any).message}`);
      throw err;
    }

    try {
      if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg as any);
    } catch (err) {
      console.log(`[downloader] ffmpeg.setFfmpegPath failed: ${(err as any).message}`);
    }
  } catch (e) {
   
  }
  
  try {
    const test = cp.spawnSync(resolvedFfmpeg as string, ["-version"], { encoding: "utf8", windowsHide: true });
    console.log(`[downloader] spawnSync ffmpeg -> status=${test.status} signal=${test.signal} error=${test.error ? test.error.message : "none"}`);
    if (test.stdout) console.log(`[downloader] ffmpeg stdout: ${String(test.stdout).slice(0,200)}`);
    if (test.stderr) console.log(`[downloader] ffmpeg stderr: ${String(test.stderr).slice(0,200)}`);
  } catch (err) {
    console.log(`[downloader] spawnSync ffmpeg threw: ${(err as any).message}`);
  }
} catch (e) {
  
}
  try {
    const test2 = cp.spawnSync(resolvedFfprobe as string, ["-version"], { encoding: "utf8", windowsHide: true });
    console.log(`[downloader] spawnSync ffprobe -> status=${test2.status} signal=${test2.signal} error=${test2.error ? test2.error.message : "none"}`);
    if (test2.stdout) console.log(`[downloader] ffprobe stdout: ${String(test2.stdout).slice(0,200)}`);
    if (test2.stderr) console.log(`[downloader] ffprobe stderr: ${String(test2.stderr).slice(0,200)}`);
  } catch (err) {
    console.log(`[downloader] spawnSync ffprobe threw: ${(err as any).message}`);
  }
try {
  
  if (resolvedFfprobe) {
    try {
      process.env.FFPROBE_PATH = resolvedFfprobe;
    } catch {}
    try {
      if (!ffmpeg) ffmpeg = require("fluent-ffmpeg");
      ffmpeg.setFfprobePath(resolvedFfprobe as any);
    } catch (err) {
      console.log(`[downloader] ffmpeg.setFfprobePath failed: ${(err as any).message}`);
    }
  }
} catch (e) {}


const tempDir = path.join(os.tmpdir(), "discord-lastfm-bot");
fsp.mkdir(tempDir, { recursive: true }).catch(() => {});


export async function downloadMP3(url: string, trackId: string): Promise<string> {
  const mp3Path = path.join(tempDir, `${trackId}.mp3`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download preview (${res.status})`);

  
  try {
    const arrayBuf = await (res as any).arrayBuffer();
    await fsp.writeFile(mp3Path, Buffer.from(arrayBuf));
    return mp3Path;
  } catch (err) {
    
    const fallbackRes = await fetch(url);
    const body = (fallbackRes as any).body;
    if (!body) throw new Error("Response body is null (fallback)");
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(mp3Path);
      body.pipe(fileStream);
      body.on("error", reject);
      fileStream.on("finish", () => resolve(true));
      fileStream.on("error", reject);
    });
    return mp3Path;
  }
}


export async function downloadAndConvert(url: string, trackId: string): Promise<string> {
  const mp3Path = await downloadMP3(url, trackId);
  const oggPath = path.join(tempDir, `${trackId}.ogg`);

  await new Promise((resolve, reject) => {
    ffmpeg(mp3Path)
      .noVideo()
      .audioChannels(1)
      .audioCodec("libopus")
      .format("ogg")
      .outputOptions(["-vbr on"])
      .output(oggPath)
      .on("end", () => resolve(true))
      .on("error", (err: any) => reject(err))
      .run();
  });

  
  await fsp.unlink(mp3Path).catch(() => {});
  return oggPath;
}


export async function getAudioSignalAndSr(trackId: string, url: string): Promise<{ signal: Float32Array; sampleRate: number }> {
  const mp3Path = await downloadMP3(url, trackId);
  let rawPath: string | undefined;
  try {
    
    const metadata: any = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(mp3Path, (err: any, data: any) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const sampleRate = Number(metadata.streams.find((s: any) => s.codec_type === "audio").sample_rate) || 44100;
    console.log(`[downloader] downloaded mp3=${mp3Path} size=${fs.statSync(mp3Path).size} bytes, sampleRate=${sampleRate}`);

    
  rawPath = path.join(tempDir, `${trackId}.raw`);
    await new Promise((resolve, reject) => {
      ffmpeg(mp3Path)
        .audioChannels(1)
        .audioCodec("pcm_f32le")
        .format("f32le")
        .output(rawPath!)
        .on("end", () => resolve(true))
        .on("error", (err: any) => reject(err))
        .run();
    });
    
    const buffer = await fsp.readFile(rawPath);
    const signal = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
    console.log(`[downloader] raw=${rawPath} size=${buffer.length} bytes, samples=${signal.length}`);

    return { signal, sampleRate };
  } finally {
    await fsp.unlink(mp3Path).catch(() => {});
    if (rawPath) await fsp.unlink(rawPath).catch(() => {});
  }
}