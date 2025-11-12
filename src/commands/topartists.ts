// src/commands/topartists.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  TextChannel,
  ComponentType,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";

dotenv.config();

// Helper function to fetch a page of top artists
async function fetchTopArtistsPage(
  username: string,
  period: string,
  page: number,
  limit: number,
  apiKey: string
) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${encodeURIComponent(
    username
  )}&period=${period}&api_key=${apiKey}&format=json&page=${page}&limit=${limit}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.error || !data.topartists) {
      console.error("Last.fm API error:", data.message);
      return null;
    }

    const artists = data.topartists.artist || [];
    const attrs = data.topartists["@attr"];
    const totalArtists = parseInt(attrs.total || "0");
    const totalPages = parseInt(attrs.totalPages || "1");

    const artistList = artists.map((artist: any, index: number) => {
      const rank = (page - 1) * limit + 1 + index;
      const artistName = artist.name;
      const artistUrl = artist.url;
      const plays = parseInt(artist.playcount || "0").toLocaleString();
      return `**${rank}.** [**${artistName}**](${artistUrl}) - *${plays} plays*`;
    });

    return { artistList, totalPages, totalArtists };
  } catch (err) {
    console.error("Error fetching top artists:", err);
    return null;
  }
}

// Helper function to build the embed and buttons
function buildEmbedAndRows(
  page: number,
  totalPages: number,
  totalArtists: number,
  artistList: string[],
  period: string,
  targetUserId: string,
  targetUserName: string
) {
  const periodMap: Record<string, string> = {
    "7day": "Weekly",
    "1month": "Monthly",
    "3month": "Quarterly",
    "6month": "Half-Yearly",
    "12month": "Yearly",
    "overall": "Overall",
  };

  const title = `Top ${periodMap[
    period
  ].toLowerCase()} artists for ${targetUserName}`;
  const description =
    artistList.length > 0
      ? artistList.join("\n")
      : "No artists found for this period.";
  const footer = `Page ${page}/${totalPages} - ${totalArtists.toLocaleString()} different artists`;

  const embed = new EmbedBuilder()
    .setColor(0xd51007) // Red color
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: footer });

  // Custom ID format: command:action:targetUserId:period
  const customIdPrefix = `topartists:${targetUserId}:${period}`;

  const rows = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:first`)
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev`)
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next`)
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:last`)
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages)
  );

  return { embeds: [embed], components: [rows] };
}

export const data = new SlashCommandBuilder()
  .setName("topartists")
  .setDescription("Shows your top artists in a paginated list.")
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Time period")
      .setRequired(false)
      .addChoices(
        { name: "7 days", value: "7day" },
        { name: "1 month", value: "1month" },
        { name: "3 months", value: "3month" },
        { name: "6 months", value: "6month" },
        { name: "12 months", value: "12month" },
        { name: "Overall", value: "overall" }
      )
  )
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The user to show artists for.")
      .setRequired(false)
  );

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

  // === FIX: MOVED USER CHECK BEFORE DEFERRAL ===
  const targetUser = interaction.options.getUser("user") || interaction.user;
  const linkedUser = getUser(targetUser.id);

  if (!linkedUser) {
    const content =
      targetUser.id === interaction.user.id
        ? "❌ You haven’t linked your Last.fm account yet. Use `/link` first."
        : `❌ **${targetUser.displayName}** hasn't linked their Last.fm account yet.`;
    
    // Use interaction.reply() here, which accepts 'ephemeral'
    await interaction.reply({ content, ephemeral: true });
    return;
  }
  // === END FIX ===

  await interaction.deferReply(); // Now we defer *after* we know the user is linked

  try {
    // The user checks are already done, so we can just use the variables
    const username = linkedUser.username;
    const period = interaction.options.getString("period") ?? "7day";
    const apiKey = process.env.LASTFM_API_KEY!;
    const artistsPerPage = 10;
    let currentPage = 1;

    const pageData = await fetchTopArtistsPage(
      username,
      period,
      currentPage,
      artistsPerPage,
      apiKey
    );

    if (!pageData) {
      await interaction.editReply(
        "⚠️ Could not fetch top artists. Last.fm might be down or the user has no scrobbles."
      );
      return;
    }

    let { artistList, totalPages, totalArtists } = pageData;

    const messagePayload = buildEmbedAndRows(
      currentPage,
      totalPages,
      totalArtists,
      artistList,
      period,
      targetUser.id,
      targetUser.displayName
    );

    // +++ ADDED +++
    if (isPrefix) {
      // Add artificial delay to mimic processing time (5+ seconds)
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    // +++ END ADDED +++

    const sentMessage = (await interaction.editReply(
      messagePayload
    )) as Message;

    // Collector for pagination
    const collector = sentMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000, // 5 minutes
    });

    collector.on("collect", async (i) => {
      // Check if the interaction is for this specific command/user
      const [cmd, targetId, p, action] = i.customId.split(":").reverse();

      if (
        cmd !== "topartists" ||
        targetId !== targetUser.id ||
        p !== period
      ) {
        // This button is for a different command instance
        await i.reply({
          content: "This button is not for you or has expired.",
          ephemeral: true,
        });
        return;
      }

      // Check if the user clicking is the one who initiated the command
      if (i.user.id !== interaction.user.id) {
        await i.reply({
          content: "Only the person who ran the command can change pages.",
          ephemeral: true,
        });
        return;
      }

      await i.deferUpdate();

      switch (action) {
        case "first":
          currentPage = 1;
          break;
        case "prev":
          currentPage = Math.max(1, currentPage - 1);
          break;
        case "next":
          currentPage = Math.min(totalPages, currentPage + 1);
          break;
        case "last":
          currentPage = totalPages;
          break;
      }

      const newPageData = await fetchTopArtistsPage(
        username,
        period,
        currentPage,
        artistsPerPage,
        apiKey
      );

      if (newPageData) {
        const newPayload = buildEmbedAndRows(
          currentPage,
          newPageData.totalPages,
          newPageData.totalArtists,
          newPageData.artistList,
          period,
          targetUser.id,
          targetUser.displayName
        );
        await i.editReply(newPayload);
      }
    });

    collector.on("end", async () => {
      try {
        const disabledRows = buildEmbedAndRows(
          currentPage,
          totalPages,
          totalArtists,
          artistList,
          period,
          targetUser.id,
          targetUser.displayName
        ).components;
        
        disabledRows.forEach(row => 
          row.components.forEach(button => button.setDisabled(true))
        );
        
        await sentMessage.edit({ components: disabledRows });
      } catch (err) {
        console.warn("Failed to disable buttons after collector end:", err);
      }
    });
  } catch (err) {
    console.error("Error executing /topartists:", err);
    await interaction.editReply(
      "❌ Something went wrong while fetching your top artists."
    );
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}