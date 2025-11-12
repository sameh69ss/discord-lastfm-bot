import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  Message,
  TextChannel, // <-- ADDED
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";

export const data = new SlashCommandBuilder()
  .setName("spotify")
  .setDescription("Share your currently playing track as a Spotify link.");


import type { Response as FetchResponse } from "node-fetch";

async function safeJson<T = any>(res: FetchResponse): Promise<T> {

  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  const data = await safeJson<{ access_token: string; error?: string }>(response);
  if (!response.ok || !data.access_token) {
    throw new Error(`Spotify token error: ${data.error ?? "unknown error"}`);
  }
  return data.access_token;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  // +++ ADDED +++
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
      content: "❌ You haven’t linked your Last.fm account yet. Use `/link` first.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const { username, sessionKey } = linkedUser;
  const apiKey = process.env.LASTFM_API_KEY!;

  try {

    const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(
      username
    )}&api_key=${apiKey}&format=json&limit=1&sk=${encodeURIComponent(sessionKey)}`;

    const res = await fetch(recentUrl);
    const data = await safeJson<{
      recenttracks?: { track?: any[] };
    }>(res);

    const track = data?.recenttracks?.track?.[0];
    if (!track) {
      await interaction.editReply("😢 No recent track found.");
      return;
    }

    const artist = track.artist?.["#text"] ?? "Unknown Artist";
    const song = track.name ?? "Unknown Track";
    const isNowPlaying = !!track?.["@attr"]?.nowplaying;

    if (!isNowPlaying) {
      await interaction.editReply(`🎧 You’re not currently playing anything.`);
      return;
    }


    const token = await getSpotifyAccessToken();
    const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
      `${artist} ${song}`
    )}&type=track&limit=1`;

    const spotifyRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const spotifyData = await safeJson<{
      tracks?: { items?: any[] };
    }>(spotifyRes);

    const spotifyTrack = spotifyData?.tracks?.items?.[0];
    if (!spotifyTrack) {
      await interaction.editReply(
        `❌ Couldn’t find **${song}** by **${artist}** on Spotify.`
      );
      return;
    }

    const spotifyUrl = spotifyTrack.external_urls.spotify;

    // +++ ADDED +++
    if (isPrefix) {
      // Add artificial delay to mimic processing time (5+ seconds)
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    // +++ END ADDED +++

    await interaction.editReply(spotifyUrl);
  } catch (err) {
    console.error("Error in /spotify:", err);
    await interaction.editReply("⚠️ Something went wrong fetching your track.");
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}