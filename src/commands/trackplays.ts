// src/commands/trackplays.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch"; // Make sure node-fetch is imported
import { getUser } from "../scripts/storage";

export const data = new SlashCommandBuilder()
  .setName("trackplays")
  .setDescription("Show your track plays");

function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

// +++ ADDED HELPER from wkt.ts +++
async function fetchWithTimeout(url: string, options?: any, timeoutMs = 10000): Promise<any> {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
  ]);
}
// +++ END HELPER +++

export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  }

  const linkedUser = getUser(interaction.user.id);
  if (!linkedUser) {
    const content = "❌ You haven’t linked your Last.fm account yet. Use `/link` first.";
    if (isPrefix) {
      await interaction.reply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
    return;
  }

  await interaction.deferReply();

  const { username, sessionKey } = linkedUser;
  const apiKey = process.env.LASTFM_API_KEY!;

  try {
    const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(
      username
    )}&api_key=${apiKey}&format=json&limit=1&sk=${encodeURIComponent(
      sessionKey
    )}`;
    const recentRes = await fetchWithTimeout(recentUrl); // <-- Use fetchWithTimeout
    const recentData = (await recentRes.json()) as any;

    const track = recentData?.recenttracks?.track?.[0];
    if (!track) {
      await interaction.editReply({ content: "😢 No recent tracks found." });
      return;
    }

    const artist = track.artist?.["#text"] ?? "Unknown Artist";
    const song = track.name ?? "Unknown Track";

    // +++ FIX: Use user.gettrackscrobbles for total plays, same as wkt.ts +++
    const infoUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettrackscrobbles&api_key=${apiKey}&artist=${encodeURIComponent(
      artist
    )}&track=${encodeURIComponent(song)}&username=${encodeURIComponent(
      username
    )}&sk=${encodeURIComponent(sessionKey)}&format=json`;
    
    const infoRes = await fetchWithTimeout(infoUrl); // <-- Use fetchWithTimeout
    const infoData = (await infoRes.json()) as any;

    // +++ FIX: Read total from the correct property +++
    const totalPlays = safeNum(infoData?.trackscrobbles?.["@attr"]?.total);
    // +++ END FIX +++

    const makeUrl = (period: string) =>
      `https://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${encodeURIComponent(
        username
      )}&api_key=${apiKey}&format=json&period=${period}&limit=1000`;

    const [weekData, monthData] = (await Promise.allSettled([
      fetchWithTimeout(makeUrl("7day")).then((r: any) => r.json()), // <-- Use fetchWithTimeout
      fetchWithTimeout(makeUrl("1month")).then((r: any) => r.json()), // <-- Use fetchWithTimeout
    ])) as any[];

    const findPlays = (data: any) => {
      if (data.status === 'rejected') return 0;
      const list = data.value?.toptracks?.track ?? [];
      const match = list.find(
        (t: any) =>
          String(t.name).toLowerCase() === song.toLowerCase() &&
          String(t.artist?.name).toLowerCase() === artist.toLowerCase()
      );
      return safeNum(match?.playcount);
    };

    const weekPlays = findPlays(weekData);
    const monthPlays = findPlays(monthData);

    const mainLine = `**${interaction.user.displayName}** has **${totalPlays}** plays for **${song}** by **${artist}**`;

    const footerParts: string[] = [];
    if (weekPlays > 0) footerParts.push(`${weekPlays} plays last week`);
    if (monthPlays > 0) footerParts.push(`${monthPlays} plays last month`);
    const footer =
      footerParts.length > 0 ? `\n-# ${footerParts.join(" — ")}` : "";

    if (isPrefix) {
      // Add artificial delay to mimic processing time (5+ seconds)
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    await interaction.editReply({
      content: `${mainLine}${footer}`,
    });
  } catch (err) {
    console.error("Overall trackplays error:", err);
    await interaction.editReply({
      content: "⚠️ Failed to fetch your track stats.",
    });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}