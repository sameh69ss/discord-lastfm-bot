// src/commands/friend.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
  TextChannel,
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

function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function timeAgo(uts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - uts;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

const cmd = {
  data: new SlashCommandBuilder()
    .setName("friends")
    .setDescription("Show your added friends' last tracks and total scrobbles."),

  async execute(interaction: ChatInputCommandInteraction) {
    const isPrefix = (interaction as any).isPrefix;
    if (isPrefix) {
      try {
        await (interaction.channel as TextChannel).sendTyping();
      } catch (err) {
        console.error("Typing indicator failed:", err);
      }
    }

    await interaction.deferReply();

    try {
      const userStorage = getUserStorage();
      const callerId = interaction.user.id;
      const callerData = userStorage[callerId];

      if (!callerData) {
        await interaction.editReply("❌ You need to link your Last.fm account first with `/link`.");
        return;
      }

      const callerUsername = callerData.username;

      const friendsStorage = getFriendsStorage();
      const friends = friendsStorage[callerId] || [];

      if (friends.length === 0) {
        await interaction.editReply("You have no friends added yet. Use `/addfriend` to add some!");
        return;
      }

      const lines: string[] = [];
      let totalScrobbles = 0;

      for (const friendLower of friends) {
        // Find if linked
        let sessionKey: string | undefined = undefined;
        for (const uid in userStorage) {
          if (userStorage[uid].username.toLowerCase() === friendLower) {
            sessionKey = userStorage[uid].sessionKey;
            break;
          }
        }

        // Fetch user info to get canonical username and playcount (public)
        const infoUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(friendLower)}&format=json`;
        const infoRes = await fetch(infoUrl);
        const infoData = await infoRes.json() as any;

        if (infoData.error) continue; // Skip invalid

        const canonicalUsername = infoData.user?.name || friendLower;
        const playcount = safeNum(infoData.user?.playcount);
        totalScrobbles += playcount;

        // Fetch recent track
        let recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(friendLower)}&limit=1&format=json`;
        let api_sig = "";

        if (sessionKey) {
          const params: Record<string, string> = {
            method: "user.getrecenttracks",
            api_key: LASTFM_API_KEY,
            user: friendLower,
            sk: sessionKey,
            limit: "1",
          };
          let sig = "";
          Object.keys(params).sort().forEach(key => {
            sig += key + params[key];
          });
          sig += LASTFM_SHARED_SECRET;
          api_sig = crypto.createHash("md5").update(sig, "utf-8").digest("hex");
          recentUrl += `&sk=${sessionKey}&api_sig=${api_sig}`;
        }

        const recentRes = await fetch(recentUrl);
        const recentData = await recentRes.json() as any;
        if (recentData.error) continue; // Skip if error

        const track = recentData.recenttracks?.track?.[0];

        let line = `**[${canonicalUsername}](https://last.fm/user/${encodeURIComponent(canonicalUsername)})**`;

        if (track) {
          const artist = track.artist?.["#text"] || "Unknown Artist";
          const trackName = track.name || "Unknown Track";
          let suffix = "";
          if (track["@attr"]?.nowplaying) {
            suffix = " 🎶";
          } else if (track.date?.uts) {
            const uts = safeNum(track.date.uts);
            suffix = ` (${timeAgo(uts)})`;
          }
          line += ` | **${trackName}** by **${artist}**${suffix}`;
        } else {
          line += " | No recent tracks";
        }

        lines.push(line);
      }

      const description = lines.join("\n") || "No valid friends found.";

      const embed = new EmbedBuilder()
        .setColor(0xd51007)
        .setAuthor({
          name: `Last songs for ${friends.length} friend${friends.length === 1 ? "" : "s"} from ${callerUsername}`,
          url: `https://last.fm/user/${encodeURIComponent(callerUsername)}`,
          iconURL: interaction.user.avatarURL({ size: 128 }) || undefined,
        })
        .setDescription(description)
        .setFooter({ text: `Amount of scrobbles of all your friends together: ${totalScrobbles}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("Friend command error:", err);
      await interaction.editReply("❌ Failed to fetch friends' info. Try again later.");
    }
  },

  async prefixExecute(message: Message, args: string[]) {
    const interaction = createInteractionFromMessage(message, args);
    await cmd.execute(interaction as any);
  },
};

export default cmd;