// src/commands/addfriend.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;

const dataPath = path.resolve(__dirname, "../../data/data.json"); // User links storage
const friendsPath = path.resolve(__dirname, "../../data/friend.json"); // Separate friends storage

function getUserStorage() {
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, "{}");
  }
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

function getFriendsStorage() {
  if (!fs.existsSync(friendsPath)) {
    fs.writeFileSync(friendsPath, "{}");
  }
  return JSON.parse(fs.readFileSync(friendsPath, "utf8"));
}

function saveFriendsStorage(storage: any) {
  fs.writeFileSync(friendsPath, JSON.stringify(storage, null, 2));
}

async function validateLastfmUser(username: string): Promise<{ valid: boolean; public: boolean }> {
  try {
    const infoUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&format=json`;
    const infoRes = await fetch(infoUrl);
    const infoData = await infoRes.json() as any;
    if (infoData.error) return { valid: false, public: false };

    const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&limit=1&format=json`;
    const recentRes = await fetch(recentUrl);
    const recentData = await recentRes.json() as any;
    if (recentData.error) return { valid: true, public: false };

    return { valid: true, public: true };
  } catch {
    return { valid: false, public: false };
  }
}

const cmd = {
  data: new SlashCommandBuilder()
    .setName("addfriend")
    .setDescription("Add one or more friends using Last.fm username, Discord mention, or ID.")
    .addStringOption((o) =>
      o.setName("friends").setDescription("Friends to add, separated by spaces").setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
      const friendsStr = interaction.options.getString("friends")!;
      const friendsToAdd = friendsStr.trim().split(/\s+/).filter(Boolean);

      if (friendsToAdd.length === 0) {
        await interaction.editReply(
          "Please enter at least one friend to add. You can use their Last.fm usernames, Discord mention or Discord id."
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
      if (!friendsStorage[callerId]) friendsStorage[callerId] = [];

      const added: string[] = [];
      const failed: string[] = [];

      for (let f of friendsToAdd) {
        let targetUsername: string | null = null;
        let input = f;

        if (f.startsWith("<@") && f.endsWith(">")) {
          const targetId = f.slice(2, -1).replace("!", "");
          targetUsername = userStorage[targetId]?.username || null;
        } else if (/^\d+$/.test(f)) {
          targetUsername = userStorage[f]?.username || null;
        } else {
          targetUsername = f;
        }

        if (!targetUsername) {
          failed.push(input);
          continue;
        }

        const lowerTarget = targetUsername.toLowerCase();

        if (lowerTarget === callerUsername) continue; // No self-add

        if (friendsStorage[callerId].includes(lowerTarget)) continue; // Already added

        const { valid, public: isPublic } = await validateLastfmUser(targetUsername);

        if (!valid || !isPublic) {
          failed.push(targetUsername);
          continue;
        }

        friendsStorage[callerId].push(lowerTarget);
        added.push(`*[${targetUsername}](https://last.fm/user/${encodeURIComponent(targetUsername)})*`);
      }

      saveFriendsStorage(friendsStorage);

      let description = "";
      if (added.length > 0) {
        description += `Successfully added ${added.length} friend${added.length > 1 ? "s" : ""}:\n- ${added.join("\n- ")}`;
      }
      if (failed.length > 0) {
        if (description) description += "\n\n";
        description += `Could not add ${failed.length} friend${failed.length > 1 ? "s" : ""}. Please ensure you spelled their name correctly, that they exist on Last.fm and that their Last.fm recent tracks are not set to private.\n\n* ${failed.join("\n* ")}`;
      }

      if (!description) {
        description = "No friends added.";
      }

      const embed = new EmbedBuilder().setColor(0xd51007).setDescription(description);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("Addfriend command error:", err);
      await interaction.editReply("❌ Failed to add friend(s). Try again later.");
    }
  },

  async prefixExecute(message: Message, args: string[]) {
    const interaction = createInteractionFromMessage(message, [`--friends=${args.join(" ")}`]);
    await cmd.execute(interaction as any);
  },
};

export default cmd;