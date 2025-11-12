// src/commands/artistplays.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";

export const data = new SlashCommandBuilder()
  .setName("artistplays")
  .setDescription("Show your artist plays");

function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

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
    const recentRes = await fetch(recentUrl);
    const recentData = (await recentRes.json()) as any;

    const track = recentData?.recenttracks?.track?.[0];
    if (!track) {
      await interaction.editReply({ content: "😢 No recent tracks found." });
      return;
    }

    const artist = track.artist?.["#text"] ?? "Unknown Artist";

    const makeUrl = (period: string) =>
      `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${encodeURIComponent(
        username
      )}&api_key=${apiKey}&format=json&period=${period}&limit=1000&sk=${encodeURIComponent(
        sessionKey
      )}`;

    const [overallData, weekData, monthData] = (await Promise.allSettled([
      fetch(makeUrl("overall")).then((r) => r.json()),
      fetch(makeUrl("7day")).then((r) => r.json()),
      fetch(makeUrl("1month")).then((r) => r.json()),
    ])) as any[];

    const findPlays = (data: any, name: string) => {
      if (data.status === 'rejected') return 0;
      const list = data.value?.topartists?.artist ?? [];
      const match = list.find(
        (a: any) => String(a.name).toLowerCase() === name.toLowerCase()
      );
      return safeNum(match?.playcount);
    };

    const overallPlays = findPlays(overallData, artist);
    const weekPlays = findPlays(weekData, artist);
    const monthPlays = findPlays(monthData, artist);

    const subject = `**${interaction.user.displayName}** has **${overallPlays}** plays for **${artist}**`;

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
      content: `${subject}${footer}`,
    });
  } catch (err) {
    console.error("Overall artistplays error:", err);
    await interaction.editReply({
      content: "⚠️ Failed to fetch your artist stats.",
    });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}