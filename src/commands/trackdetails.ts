// src/commands/trackdetails.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";

const esPkg: any = require("essentia.js");
import { readFileSync } from "fs";
import fsp from "fs/promises";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import { getAudioSignalAndSr, downloadMP3 } from "../scripts/downloader";
import { previewMap } from "../index";

dotenv.config();

const essentia = new esPkg.Essentia(esPkg.EssentiaWASM);

function formatKey(key: string, scale: string): string {
  const sharpMap: { [key: string]: string } = {
    A: "A",
    Bb: "A#",
    B: "B",
    C: "C",
    Db: "C#",
    D: "D",
    Eb: "D#",
    E: "E",
    F: "F",
    Gb: "F#",
    G: "G",
    Ab: "G#",
  };
  if (key === "N/A") return "N/A";
  const baseKey = sharpMap[key] || key;
  return `${baseKey}${scale === "major" ? "" : "m"}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

interface TrackInfo {
  id: string; // Deezer ID or temporary interaction ID
  name: string;
  artist: string;
  url: string; // Deezer or Apple Music store URL
  previewUrl: string | null;
  durationMs: number;
  appleUrl?: string; // Apple Music Store URL (used to determine button label)
}

interface AudioFeatures {
  bpm: number;
  key: string;
}

async function searchDeezerTrack(
  artist: string,
  track: string
): Promise<TrackInfo | null> {
  const q = encodeURIComponent(`track:"${track}" artist:"${artist}"`);
  const url = `https://api.deezer.com/search?q=${q}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  const item = data?.data?.[0];
  if (!item) return null;

  return {
    id: String(item.id),
    name: item.title ?? track,
    artist: item.artist?.name ?? artist,
    url: item.link ? String(item.link) : `https://www.deezer.com/track/${item.id}`,
    previewUrl: item.preview ?? null,
    durationMs: (Number(item.duration) || 0) * 1000,
  };
}

// =========================================================================
// NEW: Comprehensive Apple Music Fallback Function
// =========================================================================
interface AppleMusicFullResult {
  trackName: string;
  artistName: string;
  durationMs: number;
  previewUrl: string | null;
  storeUrl: string; // Apple Music store URL (trackViewUrl)
}

/**
 * Searches the iTunes Search API (the public, unauthenticated Apple Music endpoint).
 * @param artist The track artist.
 * @param song The track title.
 * @returns A promise that resolves to an object with all track metadata, or null.
 */
async function searchAppleMusicTrack(
  artist: string,
  song: string
): Promise<AppleMusicFullResult | null> {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", `${artist} ${song}`);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "1");
  url.searchParams.set("country", "US"); // Adjust country code as needed

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(
        `[Apple Music Search] failed with status: ${response.status}`
      );
      return null;
    }

    const data = (await response.json()) as any;

    if (data.results.length > 0) {
      const track = data.results[0];

      if (track.trackName && track.artistName && track.trackViewUrl) {
        console.log(
          `[Apple Music Search] Found track: ${track.artistName} - ${track.trackName}`
        );
        return {
          trackName: track.trackName,
          artistName: track.artistName,
          durationMs: track.trackTimeMillis
            ? Number(track.trackTimeMillis)
            : 0,
          previewUrl: track.previewUrl ?? null,
          storeUrl: track.trackViewUrl,
        };
      }
    }
    return null;
  } catch (err) {
    console.error(`[Apple Music Search] Error during fetch:`, err);
    return null;
  }
}
// =========================================================================

async function getAudioFeaturesFromPreview(
  previewUrl: string,
  trackId: string
): Promise<AudioFeatures | null> {
  try {
    const { signal, sampleRate } = await getAudioSignalAndSr(
      trackId,
      previewUrl
    );
    const audioVector = essentia.arrayToVector(signal);

    const rhythm = essentia.RhythmExtractor2013(audioVector);
    const bpm = rhythm && rhythm.bpm ? Math.round(rhythm.bpm * 10) / 10 : 0;

    const keyData = essentia.KeyExtractor(audioVector);
    const key =
      keyData && keyData.key ? formatKey(keyData.key, keyData.scale) : "N/A";

    return { bpm, key };
  } catch (err) {
    console.error("Essentia analysis failed:", err);
    return null;
  }
}

export const data = new SlashCommandBuilder()
  .setName("trackdetails")
  .setDescription("Show metadata for your currently playing track (BPM, key)");

export async function execute(interaction: ChatInputCommandInteraction) {
  // +++ ADDED FROM COVER.TS +++
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  }
  // +++ END ADDED +++

  const linkedUser = getUser(interaction.user.id);
  if (!linkedUser) {
    await interaction.reply({
      content:
        "❌ You haven’t linked your Last.fm account yet. Use `/link` first.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const { username, sessionKey } = linkedUser;
  const apiKey = process.env.LASTFM_API_KEY!;

  try {
    const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${apiKey}&user=${encodeURIComponent(
      username
    )}&limit=1&format=json&sk=${encodeURIComponent(sessionKey)}`;
    const recentRes = await fetch(recentUrl);

    const recentData = (await recentRes.json()) as any;
    const track = recentData?.recenttracks?.track?.[0];

    if (!track) {
      await interaction.editReply({
        content: "😢 No recent tracks found.",
      });
      return;
    }

    const artist: string = track.artist?.["#text"] ?? "Unknown Artist";
    const song: string = track.name ?? "Unknown Track";

    // 1. Try Deezer first
    let trackInfo = await searchDeezerTrack(artist, song);

    // 2. FALLBACK 1: If Deezer search failed entirely (trackInfo is null), try Apple Music as primary source.
    if (!trackInfo) {
      console.log(
        "Deezer search failed entirely, trying Apple Music as primary source..."
      );
      const appleResult = await searchAppleMusicTrack(artist, song);

      if (appleResult) {
        // Construct the trackInfo object using Apple Music data
        trackInfo = {
          id: interaction.id, // Uses message.id for prefix, interaction.id for slash
          name: appleResult.trackName,
          artist: appleResult.artistName,
          url: appleResult.storeUrl, // Apple Music link as primary link
          previewUrl: appleResult.previewUrl,
          durationMs: appleResult.durationMs,
          appleUrl: appleResult.storeUrl, // Set appleUrl for dynamic button label
        };
      }
    }

    if (!trackInfo) {
      await interaction.editReply(
        `**${song}** by **${artist}** is a track that we don't have any metadata for, sorry :eyes:`
      );
      return;
    }

    // 3. FALLBACK 2: If the track was found (either Deezer or Apple Music) but is missing a preview URL, try Apple Music to fill in the missing preview/link.
    // This is useful if Deezer found the track but has no preview.
    if (!trackInfo.previewUrl && !trackInfo.appleUrl) {
      console.log(
        "Track found but missing preview, checking Apple Music for preview/link..."
      );
      const appleResult = await searchAppleMusicTrack(
        trackInfo.artist,
        trackInfo.name
      );

      if (appleResult && appleResult.previewUrl) {
        trackInfo.previewUrl = appleResult.previewUrl;
        trackInfo.appleUrl = appleResult.storeUrl;
        console.log(
          "Successfully retrieved preview from Apple Music (fallback)."
        );
      }
    }

    // 4. Get Audio Features (will use Deezer preview or Apple Music fallback preview)
    let features: AudioFeatures | null = null;
    if (trackInfo.previewUrl) {
      console.log(`[trackdetails] previewUrl=${trackInfo.previewUrl}`);
      features = await getAudioFeaturesFromPreview(
        trackInfo.previewUrl,
        trackInfo.id // This ID is now consistent!
      );
      console.log(`[trackdetails] features=${JSON.stringify(features)}`);
    }

    if (!features) {
      // This is now reached if the track was found on Deezer/Apple but the audio features analysis failed.
      await interaction.editReply(
        `**${trackInfo.name}** by **${trackInfo.artist}** is a track that we don't have **audio features** for, sorry 😔`
      );
      return;
    }

    const duration = formatDuration(trackInfo.durationMs);
    const response = `**${trackInfo.name}** by **${trackInfo.artist}** has \`${features.bpm}\` bpm, is in key \`${features.key}\` and lasts \`${duration}\``;

    // Dynamic Button Logic
    const linkURL = trackInfo.appleUrl || trackInfo.url;
    const linkLabel = trackInfo.appleUrl ? "Open on Apple Music" : "Open on Deezer";

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`preview:${interaction.id}`) // This ID is now consistent!
        .setLabel("Preview")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!trackInfo.previewUrl), // Disable button if no preview
      new ButtonBuilder() // <-- Typo fixed here
        .setURL(linkURL)
        .setLabel(linkLabel)
        .setStyle(ButtonStyle.Link)
    );

    // +++ ADDED FROM COVER.TS +++
    if (isPrefix) {
      // Add artificial delay to mimic processing time (5+ seconds)
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // +++ THIS BLOCK IS MOVED +++
    // Set the map entry *just before* replying so it doesn't expire during the artificial delay
    if (trackInfo.previewUrl) {
      previewMap.set(interaction.id, trackInfo.previewUrl); // This ID is now consistent!
    }
    // +++ END MOVE +++

    await interaction.editReply({
      content: response,
      components: [row],
    });
  } catch (err) {
    console.error("Error in /trackdetails:", err);
    await interaction.editReply({
      content: "⚠️ Failed to fetch your track data.",
    });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  // .td alias
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}