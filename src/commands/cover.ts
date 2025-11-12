// src/commands/cover.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Message,
  TextChannel,
} from "discord.js";
import { SlashCommandStringOption } from "@discordjs/builders";
import { createInteractionFromMessage, parseArgs } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { createCanvas, loadImage } from "canvas";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";

dotenv.config();

interface LastfmRecentResponse {
  recenttracks?: { track?: any[] | any };
  error?: number;
  message?: string;
}

interface LastfmTrackInfoResponse {
  track?: {
    album?: { title: string; image: Array<{ '#text': string; size: string }> };
  };
  error?: number;
  message?: string;
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;

async function getSpotifyToken(): Promise<string> {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = (await res.json()) as any;
  return data.access_token;
}

async function fetchSpotifyInfo(
  trackName: string,
  artist?: string
): Promise<{ image: string | null; trackUrl: string | null; albumName: string | null; resolvedArtist: string | null }> {
  try {
    const token = await getSpotifyToken();
    let query = `track:${encodeURIComponent(trackName)}`;
    if (artist) {
      query += ` artist:${encodeURIComponent(artist)}`;
    }
    const res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as any;
    const trackItem = data.tracks?.items?.[0];

    return {
      image: trackItem?.album?.images?.[0]?.url || null,
      trackUrl: trackItem?.external_urls?.spotify || null,
      albumName: trackItem?.album?.name || null,
      resolvedArtist: trackItem?.artists?.[0]?.name || null,
    };
  } catch (err) {
    console.error("⚠️ Spotify fetch error:", err);
    return { image: null, trackUrl: null, albumName: null, resolvedArtist: null };
  }
}

async function fetchLastfmTrackInfo(artist: string, trackName: string): Promise<{ image: string | null; albumName: string | null }> {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(trackName)}&format=json`;
    const res = await fetch(url);
    const data = await res.json() as LastfmTrackInfoResponse;
    if (data.error || !data.track) {
      return { image: null, albumName: null };
    }
    const image = data.track.album?.image?.find(i => i.size === 'extralarge')?.['#text'] || data.track.album?.image?.[0]?.['#text'] || null;
    const albumName = data.track.album?.title || null;
    return { image, albumName };
  } catch (err) {
    console.error("⚠️ Last.fm track info error:", err);
    return { image: null, albumName: null };
  }
}

const cmd = {
  data: new SlashCommandBuilder()
    .setName("cover")
    .setDescription("Show the album cover of your currently playing or last played track.")
    .addUserOption((option) =>
      option.setName("user").setDescription("Show album cover for another user.")
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("track").setDescription("The track to get the cover for").setRequired(false)
    )
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName("artist").setDescription("The artist (optional)").setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const isPrefix = (interaction as any).isPrefix;
    if (isPrefix) {
      try {
        (interaction.channel as TextChannel).sendTyping();
      } catch (err) {
        console.warn("Typing indicator failed:", err);
      }
    }

    await interaction.deferReply();

    try {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const trackOpt = interaction.options.getString("track")?.trim();
      const artistOpt = interaction.options.getString("artist")?.trim();

      let artist: string;
      let trackName: string;
      let album: string;

      if (trackOpt || artistOpt) {
        // Specified track mode
        if (!trackOpt) {
          throw new Error("Need track name");
        }
        trackName = trackOpt;

        const spotifyInfo = await fetchSpotifyInfo(trackName, artistOpt);

        if (!spotifyInfo.resolvedArtist && !artistOpt) {
          throw new Error(`No matching track found for "${trackName}"`);
        }

        artist = artistOpt || spotifyInfo.resolvedArtist!;
        album = spotifyInfo.albumName || "Unknown Album";

        let image = spotifyInfo.image;
        let trackUrlSpotify = spotifyInfo.trackUrl;

        // Fallback to Last.fm if no image or album from Spotify
        if (!image || album === "Unknown Album") {
          const lastfmInfo = await fetchLastfmTrackInfo(artist, trackName);
          if (lastfmInfo.image) image = lastfmInfo.image;
          if (lastfmInfo.albumName) album = lastfmInfo.albumName;
        }

        if (!image) {
          await interaction.editReply("⚠️ No album artwork found for this track.");
          return;
        }

        // For Spotify URL fallback
        if (!trackUrlSpotify) {
          trackUrlSpotify = `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${trackName}`)}`;
        }

        const imgRes = await fetch(image);
        const arrayBuffer = await imgRes.arrayBuffer();
        const img = await loadImage(Buffer.from(arrayBuffer));
        const canvas = createCanvas(640, 640);
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        (ctx as any).imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, 640, 640);
        const buffer = canvas.toBuffer("image/jpeg", { quality: 0.95 });
        const attachment = new AttachmentBuilder(buffer, {
          name: "cover.jpg",
          description: "Album cover",
        });

        const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
        const albumUrl = album !== "Unknown Album" ? `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}` : artistUrl;
        const trackUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(trackName)}`;

        const embed = new EmbedBuilder()
          .setColor(0x1db954)
          .setDescription(
            `**[${artist}](${artistUrl}) — [${album}](${albumUrl})**\n[${trackName}](${trackUrlLastfm})\n-# Requested by ${interaction.user.displayName}`
          );

        const button = new ButtonBuilder()
          .setLabel("View on Spotify")
          .setStyle(ButtonStyle.Link)
          .setURL(
            trackUrlSpotify
          );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

        if (isPrefix) {
          // Add artificial delay to mimic processing time (5+ seconds)
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        await interaction.editReply({
          files: [attachment],
          embeds: [embed],
          components: [row],
        });
      } else {
        // Recent track mode
        const userData = getUser(targetUser.id);

        if (!userData) {
          await interaction.editReply(
            "❌ This user hasn’t linked their Last.fm account yet. Use `/link` first."
          );
          return;
        }

        const { username, sessionKey } = userData;
        const apiKey = LASTFM_API_KEY;

        // Fetch recent track
        const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${apiKey}&limit=1&format=json&sk=${encodeURIComponent(sessionKey)}`;
        const recentRes = await fetch(recentUrl);
        const recentData = await recentRes.json() as LastfmRecentResponse;

        const track = recentData.recenttracks?.track?.[0];
        if (!track) {
          await interaction.editReply("⚠️ No recent tracks found.");
          return;
        }

        artist = track.artist?.["#text"] ?? "Unknown Artist";
        album = track.album?.["#text"] ?? "Unknown Album";
        trackName = track.name ?? "Unknown Track";

        const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
        const albumUrl = `https://www.last.fm/music/${encodeURIComponent(
          artist
        )}/${encodeURIComponent(album)}`;
        const trackUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(
          artist
        )}/_/${encodeURIComponent(trackName)}`;

        // Try Spotify image first
        const spotifyInfo = await fetchSpotifyInfo(trackName, artist);
        let image = spotifyInfo.image;

        // Fallback to Last.fm
        if (!image) {
          image =
            track.image?.[track.image.length - 1]?.["#text"] ??
            track.image?.[0]?.["#text"] ??
            null;
        }

        if (!image) {
          await interaction.editReply("⚠️ No album artwork found for this track.");
          return;
        }

        const imgRes = await fetch(image);
        const arrayBuffer = await imgRes.arrayBuffer();
        const img = await loadImage(Buffer.from(arrayBuffer));
        const canvas = createCanvas(640, 640);
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        (ctx as any).imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, 640, 640);
        const buffer = canvas.toBuffer("image/jpeg", { quality: 0.95 });
        const attachment = new AttachmentBuilder(buffer, {
          name: "cover.jpg",
          description: "Album cover",
        });

        const embed = new EmbedBuilder()
          .setColor(0x1db954)
          .setDescription(
            `**[${artist}](${artistUrl}) — [${album}](${albumUrl})**\n[${trackName}](${trackUrlLastfm})\n-# Requested by ${interaction.user.displayName}`
          );

        const button = new ButtonBuilder()
          .setLabel("View on Spotify")
          .setStyle(ButtonStyle.Link)
          .setURL(
            spotifyInfo.trackUrl ||
              `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${trackName}`)}`
          );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

        if (isPrefix) {
          // Add artificial delay to mimic processing time (5+ seconds)
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        await interaction.editReply({
          files: [attachment],
          embeds: [embed],
          components: [row],
        });
      }
    } catch (err) {
      console.error("🔥 Error fetching album cover:", err);
      await interaction.editReply("❌ Failed to fetch album cover.");
    }
  },
  async prefixExecute(message: Message, args: string[]) {
    const { map, unnamed } = parseArgs(args);
    
    let track: string | undefined;
    let artist: string | undefined;
    
    if (map.track) {
      track = map.track;
    } else if (unnamed.length > 0) {
      const full = unnamed.join(' ');
      const match = full.match(/(.+) by (.+)/i);
      if (match) {
        track = match[1].trim();
        artist = match[2].trim();
      } else {
        track = full.trim();
      }
    }
    
    if (map.artist) {
      artist = map.artist;
    }
    
    let simArgs = [];
    if (track) simArgs.push(`--track=${track}`);
    if (artist) simArgs.push(`--artist=${artist}`);
    
    const interaction = createInteractionFromMessage(message, simArgs);
    await cmd.execute(interaction as any);
  },
};

export default cmd;