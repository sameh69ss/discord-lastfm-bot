// src/commands/removefriend.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fs from "fs";
import path from "path";

// Paths and storage functions from addfriend.ts
const dataPath = path.resolve(__dirname, "../../data/data.json"); // User links storage
const friendsPath = path.resolve(__dirname, "../../data/friend.json"); // Separate friends storage

function getUserStorage() {
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, "{}");
  }
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

function getFriendsStorage(): Record<string, string[]> {
  if (!fs.existsSync(friendsPath)) {
    fs.writeFileSync(friendsPath, "{}");
  }
  return JSON.parse(fs.readFileSync(friendsPath, "utf8"));
}

function saveFriendsStorage(storage: Record<string, string[]>) {
  fs.writeFileSync(friendsPath, JSON.stringify(storage, null, 2));
}

const cmd = {
  data: new SlashCommandBuilder()
    .setName("removefriend")
    .setDescription("Remove one or more friends using Last.fm username, Discord mention, or ID.")
    .addStringOption((o) =>
      o.setName("friends").setDescription("Friends to remove, separated by spaces").setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
      const friendsStr = interaction.options.getString("friends")!;
      const friendsToRemove = friendsStr.trim().split(/\s+/).filter(Boolean);

      if (friendsToRemove.length === 0) {
        await interaction.editReply(
          "Please enter at least one friend to remove. You can use their Last.fm usernames, Discord mention or Discord id."
        );
        return;
      }

      const userStorage = getUserStorage();
      const callerId = interaction.user.id;
      const callerData = userStorage[callerId];

      if (!callerData) {
        await interaction.editReply("❌ You need to link your Last.fm account first with `/link`.");
        return;
      }

      const callerUsername = callerData.username.toLowerCase();
      const friendsStorage = getFriendsStorage();
      const callerFriends = friendsStorage[callerId] || [];

      const removed: string[] = [];
      const failed: string[] = [];
      let friendsListChanged = false;

      for (let f of friendsToRemove) {
        let targetUsername: string | null = null;
        let input = f;

        // 1. Resolve Discord mention/ID to Last.fm username
        if (f.startsWith("<@") && f.endsWith(">")) {
          const targetId = f.slice(2, -1).replace("!", "");
          const targetData = userStorage[targetId];
          targetUsername = targetData?.username || null;
        } else if (/^\d+$/.test(f)) {
          const targetData = userStorage[f];
          targetUsername = targetData?.username || null;
        } else {
          // 2. Direct Last.fm username
          targetUsername = f;
        }

        if (!targetUsername) {
          failed.push(input); // Cannot resolve Discord ID/mention to a linked Last.fm user
          continue;
        }

        const lowerTarget = targetUsername.toLowerCase();

        if (lowerTarget === callerUsername) continue; // No self-remove

        const indexToRemove = callerFriends.indexOf(lowerTarget);

        if (indexToRemove !== -1) {
          // Friend found in the list, remove it
          callerFriends.splice(indexToRemove, 1);
          removed.push(`*[${targetUsername}](https://last.fm/user/${encodeURIComponent(targetUsername)})*`);
          friendsListChanged = true;
        } else {
          // Friend not found in the current list
          failed.push(input);
        }
      }

      // Update the storage only if the list changed or if the list was empty but is now populated
      if (friendsListChanged) {
        friendsStorage[callerId] = callerFriends;
        saveFriendsStorage(friendsStorage);
      }
      
      let description = "";
      if (removed.length > 0) {
        description += `Successfully removed ${removed.length} friend${removed.length > 1 ? "s" : ""}:\n- ${removed.join("\n- ")}`;
      }
      if (failed.length > 0) {
        if (description) description += "\n\n";
        description += `Could not remove ${failed.length} friend${failed.length > 1 ? "s" : ""}. They were not found in your friends list or are not linked Last.fm users.\n\n* ${failed.join("\n* ")}`;
      }

      if (!description) {
        description = "No friends removed.";
      }

      const embed = new EmbedBuilder().setColor(0xd51007).setDescription(description);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("Removefriend command error:", err);
      await interaction.editReply("❌ Failed to remove friend(s). Try again later.");
    }
  },

  async prefixExecute(message: Message, args: string[]) {
    const interaction = createInteractionFromMessage(message, [`--friends=${args.join(" ")}`]);
    await cmd.execute(interaction as any);
  },
};

export default cmd;