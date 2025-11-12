import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  TextChannel, // <-- ADDED
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";

export const data = new SlashCommandBuilder()
  .setName("albumplays")
  .setDescription("Show how many times you've played the current album or single");

function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
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
    const recentRes = await fetch(recentUrl);
    const recentData = (await recentRes.json()) as any;
    const track = recentData?.recenttracks?.track?.[0];

    if (!track) {
      await interaction.editReply({ content: "😢 No recent tracks found." });
      return;
    }

    const artist = track.artist?.["#text"] ?? "Unknown Artist";
    const album = track.album?.["#text"] ?? "";
    const song = track.name ?? "Unknown Track";

    let overallPlays = 0;
    let weekPlays = 0;
    let monthPlays = 0;
    let isTrackMode = false;

    
    const makeUrl = (method: string, params: string) =>
      `https://ws.audioscrobbler.com/2.0/?method=${method}&user=${encodeURIComponent(
        username
      )}&api_key=${apiKey}&format=json&${params}&sk=${encodeURIComponent(sessionKey)}`;

    
    if (album && album.trim() !== "") {
      const albumInfoUrl = makeUrl(
        "album.getInfo",
        `artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`
      );
      const albumRes = await fetch(albumInfoUrl);
      const albumData = (await albumRes.json()) as any;

      overallPlays = safeNum(albumData?.album?.userplaycount);
    }

    
    if (overallPlays === 0) {
      isTrackMode = true;
      const trackInfoUrl = makeUrl(
        "track.getInfo",
        `artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(song)}`
      );
      const trackRes = await fetch(trackInfoUrl);
      const trackData = (await trackRes.json()) as any;

      overallPlays = safeNum(trackData?.track?.userplaycount);
    }

    
    if (!isTrackMode && album.trim() !== "") {
      const makeTopUrl = (period: string) =>
        makeUrl("user.gettopalbums", `period=${period}&limit=1000`);
      const [weekData, monthData] = (await Promise.all([
        fetch(makeTopUrl("7day")).then((r) => r.json()),
        fetch(makeTopUrl("1month")).then((r) => r.json()),
      ])) as any[];

      const findPlays = (data: any) => {
        const albums = data?.topalbums?.album ?? [];
        const match = albums.find(
          (a: any) =>
            a.name?.toLowerCase() === album.toLowerCase() &&
            a.artist?.name?.toLowerCase() === artist.toLowerCase()
        );
        return safeNum(match?.playcount);
      };

      weekPlays = findPlays(weekData);
      monthPlays = findPlays(monthData);
    }

    
    const subject = `**${interaction.user.displayName}** has **${overallPlays}** plays for **${
      isTrackMode ? song : album
    }** by **${artist}**`;

    const footerParts: string[] = [];
    if (weekPlays > 0) footerParts.push(`${weekPlays} plays last week`);
    if (monthPlays > 0) footerParts.push(`${monthPlays} plays last month`);

    const footer = footerParts.length > 0 ? `\n-# ${footerParts.join(" — ")}` : "";

    // +++ ADDED +++
    if (isPrefix) {
      // Add artificial delay to mimic processing time (5+ seconds)
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    // +++ END ADDED +++

    await interaction.editReply({
      content: `${subject}${footer}`,
    });
  } catch (err) {
    console.error("🔥 Error in /albumplays:", err);
    await interaction.editReply({
      content: "⚠️ Failed to fetch your play stats.",
    });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}