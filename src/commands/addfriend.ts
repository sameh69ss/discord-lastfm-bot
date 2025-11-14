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
import crypto from "crypto";

dotenv.config();

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const LASTFM_SHARED_SECRET = process.env.LASTFM_SHARED_SECRET!;

const dataPath = path.resolve(__dirname, "../../data/data.json"); // User links storage
const friendsPath = path.resolve(__dirname, "../../data/friend.json"); // Separate friends storage

// Utility function to safely convert to number
function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

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

async function validateLastfmUser(username: string, sessionKey?: string): Promise<{ valid: boolean; accessible: boolean }> {
  try {
    const infoUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&format=json`;
    const infoRes = await fetch(infoUrl);
    const infoData = await infoRes.json() as any;
    
    // 1. Check if user exists (API error)
    if (infoData.error) return { valid: false, accessible: false };

    // 2. NEW: Check if user has any scrobbles
    const totalScrobbles = safeNum(infoData.user?.playcount);
    if (totalScrobbles === 0) {
      return { valid: false, accessible: false }; // Treat as invalid if 0 scrobbles
    }

    // Optional: Check recent tracks if session key is provided
    let accessible = false;
    if (sessionKey) {
      let recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&limit=1&format=json`;
      const params: Record<string, string> = {
        method: "user.getrecenttracks",
        api_key: LASTFM_API_KEY,
        user: username,
        sk: sessionKey,
        limit: "1",
      };
      let sig = "";
      Object.keys(params).sort().forEach(key => {
        sig += key + params[key];
      });
      sig += LASTFM_SHARED_SECRET;
      const api_sig = crypto.createHash("md5").update(sig, "utf-8").digest("hex");
      recentUrl += `&sk=${sessionKey}&api_sig=${api_sig}`;

      const recentRes = await fetch(recentUrl);
      const recentData = await recentRes.json() as any;
      accessible = !recentData.error;
    } else {
      // For non-linked, we don't require accessible recent tracks anymore
      accessible = true; // Assume accessible if profile exists
    }

    return { valid: true, accessible };
  } catch {
    return { valid: false, accessible: false };
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
        let targetSessionKey: string | undefined = undefined;
        let input = f;

        if (f.startsWith("<@") && f.endsWith(">")) {
          const targetId = f.slice(2, -1).replace("!", "");
          const targetData = userStorage[targetId];
          targetUsername = targetData?.username || null;
          targetSessionKey = targetData?.sessionKey;
        } else if (/^\d+$/.test(f)) {
          const targetData = userStorage[f];
          targetUsername = targetData?.username || null;
          targetSessionKey = targetData?.sessionKey;
        } else {
          targetUsername = f;
          // Check if this username is linked
          for (const uid in userStorage) {
            if (userStorage[uid].username.toLowerCase() === f.toLowerCase()) {
              targetSessionKey = userStorage[uid].sessionKey;
              break;
            }
          }
        }

        if (!targetUsername) {
          failed.push(input);
          continue;
        }

        const lowerTarget = targetUsername.toLowerCase();

        if (lowerTarget === callerUsername) continue; // No self-add

        if (friendsStorage[callerId].includes(lowerTarget)) continue; // Already added

        const { valid, accessible } = await validateLastfmUser(targetUsername, targetSessionKey);

        if (!valid) {
          failed.push(input); // This will now catch 0-scrobble accounts
          continue;
        }

        // Add even if not accessible, as long as valid
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
        description += `Could not add ${failed.length} friend${failed.length > 1 ? "s" : ""}. Please ensure you spelled their name correctly and that they exist on Last.fm (and have at least 1 scrobble).\n\n* ${failed.join("\n* ")}`;
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