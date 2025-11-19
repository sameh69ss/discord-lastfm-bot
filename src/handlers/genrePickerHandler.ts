
// src/handlers/genrePickerHandler.ts
import {
  StringSelectMenuInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  getFriendsStorage,
  getUserStorage,
  getImage,
  getArtistGenres,
  getArtistTags,
  getGenrePlays,
  isRTL,
  capitalize,
  FM_COLOR,
  getDisplayName,
} from "../commands/fwkg";
import { getUser } from "../scripts/storage";

export async function handleGenrePicker(interaction: StringSelectMenuInteraction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    console.error('Defer update failed:', e);
    return;
  }

  try {
    const value = interaction.values[0];
    const [callerId, , , lowerGenre, artist] = value.split('~');

    const linkedUser = getUser(callerId);
    if (!linkedUser) {
      await interaction.followUp({ content: "❌ User not linked to Last.fm.", ephemeral: true });
      return;
    }
    const callerUsername = linkedUser.username.toLowerCase();

    const friends = getFriendsStorage()[callerId] || [];
    const allUsernames = new Set([callerUsername, ...friends]);

    // Helper to get Discord ID for Last.fm username
    function getDiscordIdForLastfm(lowerUsername: string): string | null {
      const storage = getUserStorage();
      for (const uid in storage) {
        if (storage[uid].username.toLowerCase() === lowerUsername) {
          return uid;
        }
      }
      return null;
    }

    // Get display names
    const displayNames: Record<string, string> = {};
    for (const lowerUsername of allUsernames) {
      const discordId = getDiscordIdForLastfm(lowerUsername);
      const disp = await getDisplayName(interaction, interaction.guild, lowerUsername, discordId);
      displayNames[lowerUsername] = disp;
    }

    // Compute plays
    const playsList = await Promise.all(Array.from(allUsernames).map(lowerUsername => getGenrePlays(lowerUsername, lowerGenre)));
    const ranks: { lowerUsername: string; plays: number }[] = [];
    let i = 0;
    for (const lowerUsername of allUsernames) {
      const plays = playsList[i++];
      if (plays > 0 || lowerUsername === callerUsername) {
        ranks.push({ lowerUsername, plays });
      }
    }
    ranks.sort((a, b) => b.plays - a.plays);

    // Build description
    let description = '\u200E';
    if (ranks.length === 0) {
      description += 'You and your friends have 0 plays for this genre.';
    } else {
      description += ranks.map((r, idx) => {
        const name = displayNames[r.lowerUsername];
        const nameFormatted = isRTL(name) ? `\u2067${name}\u2069` : name;
        const userLink = `[**${nameFormatted}**](https://www.last.fm/user/${encodeURIComponent(r.lowerUsername)})`;
        return `\u200E${idx + 1}.\u200E \u200E${userLink}\u200E - \u200E**${r.plays}** plays`;
      }).join('\n');
    }

    // Stats
    const listeners = ranks.length;
    const totalPlays = ranks.reduce((sum, r) => sum + r.plays, 0);
    const avgPlays = listeners > 0 ? Math.round(totalPlays / listeners) : 0;
    const listenerText = listeners === 1 ? 'listener' : 'listeners';

    // Image
    const image = await getImage("artist", { artist }) || null;

    // Embed
    const embed = new EmbedBuilder()
      .setColor(FM_COLOR)
      .setTitle(`${capitalize(lowerGenre)} with friends`)
      .setDescription(description)
      .setThumbnail(image)
      .setFooter({ text: `Friends WhoKnow genre for ${displayNames[callerUsername]}\nGenre - ${listeners} ${listenerText} - ${totalPlays} plays - ${avgPlays} avg` });

    // Rebuild select menu with default selected
    let genres = await getArtistGenres(artist);
    if (genres.length === 0) {
      genres = await getArtistTags(artist);
    }
    const options = genres.map((g: string) => ({
      label: capitalize(g),
      value: `${callerId}~${callerId}~friendwhoknows~${g.toLowerCase()}~${artist}`,
      default: g.toLowerCase() === lowerGenre,
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId("genre-picker")
      .setPlaceholder("Select genre to view Friends WhoKnow")
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    // Update the message using editReply
    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error("Genre picker error:", err);
    await interaction.followUp({ content: "⚠️ Failed to process selection.", ephemeral: true });
  }
}
