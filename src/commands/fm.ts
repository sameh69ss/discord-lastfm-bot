// src/commands/fm.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  Message,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";

dotenv.config();

export const data = new SlashCommandBuilder()
  .setName("fm")
  .setDescription("Show your currently playing or last scrobbled track")
  .addUserOption(option =>
    option.setName("user")
      .setDescription("The user to show the recent track for (defaults to yourself)")
      .setRequired(false)
  );

function safeNum(v: unknown) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function formatTime(uts?: number): string {
  if (!uts) return "Unknown";
  const date = new Date(uts * 1000);
  const now = new Date();

  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) /
      (1000 * 60 * 60 * 24)
  );

  let prefix: string;
  if (diffDays === 0) prefix = "Today";
  else if (diffDays === 1) prefix = "Yesterday";
  else {
    prefix = date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  return `${prefix} ${time}`;
}

/* ---------- Spotify utils ---------- */
async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function searchSpotifyCover(
  artist: string,
  album: string
): Promise<string | null> {
  try {
    const accessToken = await getSpotifyAccessToken();
    const query = encodeURIComponent(`${artist} ${album}`);
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${query}&type=album&limit=1`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const data = (await res.json()) as {
      albums?: { items?: { images?: { url: string }[] }[] };
    };

    const cover = data.albums?.items?.[0]?.images?.[0]?.url;
    return cover || null;
  } catch (err) {
    console.warn("⚠️ Spotify lookup failed:", err);
    return null;
  }
}

/* ---------- /fm command ---------- */
export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  }

  const target = interaction.options.getUser("user") || interaction.user;

  let displayName: string;
  let avatarURL: string;

  if (interaction.guild) {
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    displayName = member?.displayName || target.username;
    avatarURL = member?.displayAvatarURL({ size: 128 }) || target.displayAvatarURL({ size: 128 });
  } else {
    displayName = target.displayName || target.username;
    avatarURL = target.displayAvatarURL({ size: 128 });
  }

  const linkedUser = getUser(target.id);
  if (!linkedUser) {
    const replyMethod = isPrefix ? 'reply' : 'reply';
    const ephemeral = !isPrefix;
    
    const errorMessage = target.id === interaction.user.id
      ? "❌ You haven’t linked your Last.fm account yet. Use `/link` first."
      : `❌ ${displayName} hasn’t linked their Last.fm account yet.`;

    await interaction[replyMethod]({
      content: errorMessage,
      ephemeral: ephemeral,
    });
    return;
  }

  if (!isPrefix) {
    await interaction.deferReply();
  }

  const { username, sessionKey } = linkedUser;
  const apiKey = process.env.LASTFM_API_KEY!;
  
  const reply = async (options: any) => {
    if (isPrefix) {
      return interaction.reply(options);
    }
    return interaction.editReply(options);
  }

  try {
    // Fetch recent track
    const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${apiKey}&user=${encodeURIComponent(
      username
    )}&limit=1&format=json&sk=${encodeURIComponent(sessionKey)}`;
    const recentRes = await fetch(recentUrl);
    const recentData = (await recentRes.json()) as any;

    if (recentData?.error) {
      await reply({
        content: `⚠️ Last.fm error: ${recentData.message}`,
      });
      return;
    }

    const track = recentData?.recenttracks?.track?.[0];
    if (!track) {
      await reply({
        content: "😢 No recent tracks found.",
      });
      return;
    }

    const artist: string = track.artist?.["#text"] ?? "Unknown Artist";
    const song: string = track.name ?? "Unknown Track";
    const album: string = track.album?.["#text"] ?? "Unknown Album";
    const trackUrl: string = track.url ?? "";
    const lastfmImage: string | null =
      track.image?.find((i: any) => i.size === "extralarge")?.["#text"] ?? null;
    const isNowPlaying: boolean = !!track?.["@attr"]?.nowplaying;
    const dateUts: number | undefined = track?.date?.uts
      ? Number(track.date.uts)
      : undefined;

    // Fetch user info
    const userInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&api_key=${apiKey}&user=${encodeURIComponent(
      username
    )}&format=json`;
    const userInfoRes = await fetch(userInfoUrl);
    const userInfo = (await userInfoRes.json()) as any;
    const totalScrobbles = safeNum(userInfo?.user?.playcount);
    const lastfmProfile =
      userInfo?.user?.url ?? `https://www.last.fm/user/${username}`;

    // Artist plays
    let artistPlays = 0;
    try {
      const artistInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(
        artist
      )}&username=${encodeURIComponent(
        username
      )}&format=json&sk=${encodeURIComponent(sessionKey)}&autocorrect=1`;
      const artistInfoRes = await fetch(artistInfoUrl);
      const artistInfo = (await artistInfoRes.json()) as any;
      artistPlays = safeNum(artistInfo?.artist?.stats?.userplaycount);
    } catch {
      artistPlays = 0;
    }

    // +++ THIS IS THE FIX: Use user.gettrackscrobbles +++
    let trackPlays = 0;
    try {
      const trackScrobbleUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettrackscrobbles&api_key=${apiKey}&artist=${encodeURIComponent(
        artist
      )}&track=${encodeURIComponent(
        song
      )}&username=${encodeURIComponent(
        username
      )}&format=json&sk=${encodeURIComponent(sessionKey)}&autocorrect=1`;
      
      const trackScrobbleRes = await fetch(trackScrobbleUrl);
      const trackScrobbleData = (await trackScrobbleRes.json()) as any;
      
      // The 'total' attribute is the correct playcount
      trackPlays = safeNum(trackScrobbleData?.trackscrobbles?.["@attr"]?.total);

    } catch(err) {
      console.warn("Failed to get track plays via user.gettrackscrobbles:", err);
      trackPlays = 0; // Fallback to 0 if this fails
    }
    // +++ END FIX +++

    // Try Spotify image first
    let image: string | null = null;
    try {
      image = await searchSpotifyCover(artist, album);
    } catch {
      image = null;
    }

    if (!image) image = lastfmImage;

    const authorTitle = isNowPlaying
      ? `Now playing - ${displayName}`
      : `Last track for - ${displayName}`;

    const scrobbleTime = !isNowPlaying
      ? `Last scrobbled • ${formatTime(dateUts)}`
      : ""; 

    const embed = new EmbedBuilder()
      .setColor("#1DB954") 
      .setAuthor({
        name: authorTitle,
        url: lastfmProfile,
        iconURL: avatarURL,
      })
      .setTitle(song)
      .setURL(trackUrl)
      .setDescription(`**${artist}** • *${album}*`)
      .setThumbnail(image)
      .setFooter({
        text: `${artistPlays} artist scrobbles · ${trackPlays} track scrobbles · ${totalScrobbles} total scrobbles\n${scrobbleTime}`,
      });

    if (isPrefix) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    await reply({ embeds: [embed] });
  } catch (err) {
    console.error("Error in /fm:", err);
    await reply({
      content: "⚠️ Failed to fetch your Last.fm or Spotify data.",
    });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}