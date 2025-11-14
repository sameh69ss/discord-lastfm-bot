// src/commands/profile.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  Message,
  ComponentType,
  ButtonInteraction,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch from "node-fetch";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";

dotenv.config();

// This path points to the file storing friend relationships
const friendsPath = path.resolve(__dirname, "../../data/friend.json");

// Reads the friend.json storage file
function getFriendsStorage() {
  if (!fs.existsSync(friendsPath)) {
    fs.writeFileSync(friendsPath, "{}");
  }
  return JSON.parse(fs.readFileSync(friendsPath, "utf8"));
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const LASTFM_SHARED_SECRET = process.env.LASTFM_SHARED_SECRET!;
const MONTHS_TO_SHOW = 6;
const FM_COLOR = 0xd51007;
const DEFAULT_TRACK_DURATION_SEC = 180; // Fallback if no durations available
const DEFAULT_LASTFM_AVATAR_HASHES = new Set<string>([
  // Known placeholder hashes (default profile + generic art fallback)
  "818148bf682d429dc215c1705eb27b98",
  "2a96cbd8b46e442fc41c2b86b821562f",
]);

export const data = new SlashCommandBuilder()
  .setName("profile")
  .setDescription("Show your Last.fm profile stats")
  .addUserOption(option =>
    option.setName("user")
      .setDescription("The user to show stats for (defaults to yourself)")
      .setRequired(false)
  );

function safeNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function formatNumber(num: number): string {
  return num.toString();
}

function formatDecimal(num: number): string {
  return num.toFixed(1).replace('.', ',');
}

function formatPercentage(num: number): string {
  return formatDecimal(num) + "%";
}

function formatPlayTime(seconds: number): string {
  const totalHours = Math.floor(seconds / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  let result = "";
  if (days > 0) result += `${days} day${days === 1 ? "" : "s"}`;
  if (hours > 0) {
    if (days > 0) result += ", ";
    result += `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (result === "") result = "0 hours";
  return result;
}

function getMonthStartEnd(now: Date, monthOffset: number): { start: number; end: number; name: string } {
  const year = now.getFullYear();
  const month = now.getMonth() - monthOffset;
  const startDate = new Date(year, month, 1, 0, 0, 0);
  const start = Math.floor(startDate.getTime() / 1000);
  const endDate = new Date(year, month + 1, 1, 0, 0, 0);
  endDate.setSeconds(-1);
  const end = Math.floor(endDate.getTime() / 1000);
  const name = startDate.toLocaleString("default", { month: "long" });
  return { start, end, name };
}

function isDefaultLastfmAvatar(url?: string | null): boolean {
  if (!url) return true;
  const trimmed = url.trim();
  if (!trimmed) return true;

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") return true;

    const pathname = parsed.pathname.toLowerCase();
    // Last.fm serves default avatars from /avatar<size>s/ folders; treat them as placeholders.
    if (pathname.includes("/avatar")) {
      return true;
    }

    const filename = path.basename(parsed.pathname).split(".")[0]?.toLowerCase();
    if (!filename) return true;

    return DEFAULT_LASTFM_AVATAR_HASHES.has(filename);
  } catch {
    return true;
  }
}

function isAccessoryBaseTypeError(err: any): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as any).code !== 50035) return false;
  const message = String((err as any).message ?? "");
  if (message.includes("accessory[BASE_TYPE_REQUIRED]")) {
    return true;
  }
  const raw = (err as any).rawError;
  if (!raw) return false;
  try {
    const serialized = JSON.stringify(raw);
    return serialized.includes("accessory") && serialized.includes("BASE_TYPE_REQUIRED");
  } catch {
    return false;
  }
}

async function getMostActiveDay(username: string, sessionKey: string): Promise<string> {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayCounts = new Array(7).fill(0);
  let page = 1;
  const limit = 200;
  const maxPages = 10; // Reduced for speed

  while (page <= maxPages) {
    const params: Record<string, string> = {
      method: "user.getrecenttracks",
      api_key: LASTFM_API_KEY,
      user: username,
      sk: sessionKey,
      limit: limit.toString(),
      page: page.toString()
    };
    
    let sig = "";
    Object.keys(params).sort().forEach(key => {
      sig += key + params[key];
    });
    sig += LASTFM_SHARED_SECRET;
    
    const api_sig = crypto.createHash("md5").update(sig, "utf-8").digest("hex");
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&sk=${sessionKey}&limit=${limit}&page=${page}&api_sig=${api_sig}&format=json`;

    const res = await fetch(url);
    const data = await res.json() as any;
    const tracks = data.recenttracks?.track || [];
    if (tracks.length === 0) break;

    for (const track of tracks) {
      const uts = track.date?.uts;
      if (uts) {
        const date = new Date(uts * 1000);
        const day = date.getDay();
        dayCounts[day]++;
      }
    }
    page++;
  }

  const maxCount = Math.max(...dayCounts);
  if (maxCount === 0) return "Sunday"; // Default if no tracks found
  const maxIndex = dayCounts.indexOf(maxCount);
  return days[maxIndex];
}

async function getMonthlyStats(username: string, sessionKey: string, start: number, end: number) {
  // First, get total plays with limit=1
  let params: Record<string, string> = {
    method: "user.getrecenttracks",
    api_key: LASTFM_API_KEY,
    user: username,
    sk: sessionKey,
    from: start.toString(),
    to: end.toString(),
    limit: "1"
  };

  let sig = "";
  Object.keys(params).sort().forEach(key => {
    sig += key + params[key];
  });
  sig += LASTFM_SHARED_SECRET;

  let api_sig = crypto.createHash("md5").update(sig, "utf-8").digest("hex");
  let url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&sk=${sessionKey}&from=${start}&to=${end}&limit=1&api_sig=${api_sig}&format=json`;
  
  let res = await fetch(url);
  let data = await res.json() as any;
  const plays = safeNum(data.recenttracks?.["@attr"]?.total);

  if (plays === 0) {
    return { plays, totalSec: 0 };
  }

  // Now, page through recent tracks to sum durations
  let totalSec = 0;
  let fetchedTracks = 0;
  let sumKnownDur = 0;
  let countKnownDur = 0;
  const limit = 200;
  const maxPages = 50; // Limit to avoid too many API calls
  let page = 1;

  while (true) {
    params = {
      method: "user.getrecenttracks",
      api_key: LASTFM_API_KEY,
      user: username,
      sk: sessionKey,
      from: start.toString(),
      to: end.toString(),
      limit: limit.toString(),
      page: page.toString()
    };

    sig = "";
    Object.keys(params).sort().forEach(key => {
      sig += key + params[key];
    });
    sig += LASTFM_SHARED_SECRET;

    api_sig = crypto.createHash("md5").update(sig, "utf-8").digest("hex");
    url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&sk=${sessionKey}&from=${start}&to=${end}&limit=${limit}&page=${page}&api_sig=${api_sig}&format=json`;

    res = await fetch(url);
    data = await res.json() as any;
    const tracks = data.recenttracks?.track || [];
    if (tracks.length === 0) break;

    for (const track of tracks) {
      const d = safeNum(track.duration);
      totalSec += d > 0 ? d : DEFAULT_TRACK_DURATION_SEC;
      if (d > 0) {
        sumKnownDur += d;
        countKnownDur++;
      }
      fetchedTracks++;
    }

    if (tracks.length < limit || page >= maxPages) break;
    page++;
  }

  // If not all fetched, estimate remaining using average known duration
  if (fetchedTracks < plays) {
    const avgDur = countKnownDur > 0 ? sumKnownDur / countKnownDur : DEFAULT_TRACK_DURATION_SEC;
    totalSec += (plays - fetchedTracks) * avgDur;
  }

  return { plays, totalSec: Math.round(totalSec) };
}

async function execute(interaction: ChatInputCommandInteraction | any) {
  const isPrefix = interaction.isPrefix;

  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  }

  if (!isPrefix) await interaction.deferReply();

  const target = interaction.options.getUser("user") || interaction.user;
  const linkedUser = getUser(target.id);
  if (!linkedUser) {
    return interaction.reply({
      content: target.id === interaction.user.id
        ? "❌ You haven’t linked your Last.fm account yet. Use `/link` first."
        : `❌ ${target.username} hasn’t linked their Last.fm account yet.`,
      ephemeral: true,
    });
  }

  const { username, sessionKey } = linkedUser;
  const replyMethod = isPrefix ? "reply" : "editReply";

  try {
    // Fetch user info
    const userInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&format=json`;
    const userInfoRes = await fetch(userInfoUrl);
    const userInfo = await userInfoRes.json() as any;
    if (userInfo.error) throw new Error(userInfo.message);
    const totalScrobbles = safeNum(userInfo.user.playcount);
    const registered = safeNum(userInfo.user.registered.unixtime);
    const lastfmUrl = userInfo.user.url;
    const profilePic = userInfo.user.image?.find((i: any) => i.size === "extralarge")?.["#text"] || userInfo.user.image?.[0]?.["#text"] || null;

    // Fetch latest scrobble time
    const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&limit=1&format=json`;
    const recentRes = await fetch(recentUrl);
    const recentData = await recentRes.json() as any;
    
    let latestTime = Date.now() / 1000; // Default to now
    if (recentData.recenttracks?.track?.length > 0) {
      const track = recentData.recenttracks.track[0];
      if (track["@attr"]?.nowplaying) {
        latestTime = Date.now() / 1000;
      } else {
        const uts = safeNum(track.date?.uts);
        if (uts > 0) {
          latestTime = uts; 
        }
      }
    }

    // Use latestTime for calculations
    const nowDate = new Date(latestTime * 1000);
    const daysSince = Math.max(1, Math.floor((latestTime - registered) / 86400));
    const avgScrobblesPerDay = formatDecimal(totalScrobbles / daysSince);

    // Fetch unique counts
    const artistsUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&period=overall&limit=1&format=json`;
    const artistsRes = await fetch(artistsUrl);
    const artistsData = await artistsRes.json() as any;
    const uniqueArtists = safeNum(artistsData.topartists?.["@attr"]?.total);

    const albumsUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&period=overall&limit=1&format=json`;
    const albumsRes = await fetch(albumsUrl);
    const albumsData = await albumsRes.json() as any;
    const uniqueAlbums = safeNum(albumsData.topalbums?.["@attr"]?.total);

    const tracksUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&period=overall&limit=1&format=json`;
    const tracksRes = await fetch(tracksUrl);
    const tracksData = await tracksRes.json() as any;
    const uniqueTracks = safeNum(tracksData.toptracks?.["@attr"]?.total);

    // Averages per artist
    const avgAlbumsPerArtist = uniqueArtists > 0 ? formatDecimal(uniqueAlbums / uniqueArtists) : "0,0";
    const avgTracksPerArtist = uniqueArtists > 0 ? formatDecimal(uniqueTracks / uniqueArtists) : "0,0";

    // Top 10 artists percentage
    const topArtistsUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&api_key=${LASTFM_API_KEY}&user=${encodeURIComponent(username)}&period=overall&limit=10&format=json`;
    const topArtistsRes = await fetch(topArtistsUrl);
    const topArtistsData = await topArtistsRes.json() as any;
    const top10Plays = topArtistsData.topartists?.artist?.reduce((sum: number, a: any) => sum + safeNum(a.playcount), 0) || 0;
    const top10Percent = totalScrobbles > 0 ? formatPercentage((top10Plays / totalScrobbles) * 100) : "0,0%";

    // Most active day
    const mostActiveDay = await getMostActiveDay(username, sessionKey);

    // Befriended by count (number of users who have added this user as a friend)
    let friendCount = 0;
    const friendsStorage = getFriendsStorage(); // Use the correct storage function
    const targetId = target.id; // The Discord ID of the user being profiled
    const targetUsername = linkedUser.username.toLowerCase(); // The Last.fm username being profiled

    // Loop through the friends storage object
    for (const adderId in friendsStorage) { // adderId is the Discord ID of the person who added friends
      if (adderId !== targetId) { // Check that it's not the user themselves
        const friendList: string[] = friendsStorage[adderId]; // This is an array of last.fm usernames
        // Check if the array is valid and includes the target's last.fm username
        if (Array.isArray(friendList) && friendList.includes(targetUsername)) {
          friendCount++;
        }
      }
    }

    // Pre-fetch monthly stats
    const monthlyStats: { name: string; plays: number; time: string }[] = [];
    for (let i = 0; i < MONTHS_TO_SHOW; i++) {
      let { start, end, name } = getMonthStartEnd(nowDate, i);
      
      end = Math.min(end, Math.floor(latestTime)); 
      start = Math.max(start, registered); 

      if (start >= end) {
        monthlyStats.push({ name, plays: 0, time: "0 hours" });
        continue; 
      }

      const { plays, totalSec } = await getMonthlyStats(username, sessionKey, start, end);
      const timeStr = formatPlayTime(totalSec);
      monthlyStats.push({ name, plays, time: timeStr });
    }

    // Build profile header conditionally
    const headerText = `## [${username}](${lastfmUrl})\n**${formatNumber(totalScrobbles)}** scrobbles\nSince <t:${registered}:D>`;
    let profileHeaderComponent: any;

    if (typeof profilePic === "string" && !isDefaultLastfmAvatar(profilePic)) {
      profileHeaderComponent = {
        type: 9,
        components: [
          {
            type: 10,
            content: headerText
          }
        ],
        accessory: {
          type: 11,
          media: {
            url: profilePic
          }
        }
      };
    } else {
      profileHeaderComponent = {
        type: 10,
        content: headerText
      };
    }

    // Profile components with type 17 container
    const profileComponents = [
      {
        type: 17,
        accent_color: FM_COLOR,
        spoiler: false,
        components: [
          profileHeaderComponent, // <-- Use the conditionally built component
          {
            type: 14,
            spacing: 1,
            divider: true
          },
          {
            type: 10,
            content: `**${formatNumber(uniqueTracks)}** different tracks\n**${formatNumber(uniqueAlbums)}** different albums\n**${formatNumber(uniqueArtists)}** different artists`
          },
          {
            type: 14,
            spacing: 1,
            divider: true
          },
          {
            type: 10,
            content: `Average of **${avgScrobblesPerDay}** scrobbles per day\nAverage of **${avgAlbumsPerArtist}** albums and **${avgTracksPerArtist}** tracks per artist\nTop **10** artists make up **${top10Percent}** of scrobbles\nMost active day of the week is **${mostActiveDay}**`
          },
          {
            type: 14,
            spacing: 1,
            divider: true
          },
          {
            type: 10,
            content: `-# Befriended by ${friendCount}`
          }
        ]
      },
      {
        type: 1,
        components: [
          {
            type: 2,
            custom_id: "history",
            style: 2,
            label: "History",
            emoji: { name: "📖" }
          },
          {
            type: 2,
            style: 5,
            label: "Last.fm",
            url: lastfmUrl,
            emoji: { id: "882227627287515166", name: "services_lastfm" }
          }
        ]
      }
    ];

    const sent = await interaction[replyMethod]({ content: "", embeds: [], components: profileComponents, flags: 32768 });

    // Collector for buttons
    const collector = sent.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300000, // 5 minutes
    });

    collector.on("collect", async (btnInt: ButtonInteraction) => {
      await btnInt.deferUpdate();
      if (btnInt.customId === "history") {

        // Build history header conditionally
        const historyHeaderText = `## [${username}](${lastfmUrl})'s history\n**${formatNumber(totalScrobbles)}** scrobbles\nSince <t:${registered}:D>`;
        let historyHeaderComponent: any;

        if (typeof profilePic === "string" && !isDefaultLastfmAvatar(profilePic)) {
          historyHeaderComponent = {
            type: 9,
            components: [
              {
                type: 10,
                content: historyHeaderText
              }
            ],
            accessory: {
              type: 11,
              media: {
                url: profilePic
              }
            }
          };
        } else {
          historyHeaderComponent = {
            type: 10,
            content: historyHeaderText
          };
        }

        const historyComponents = [
          {
            type: 17,
            accent_color: FM_COLOR,
            spoiler: false,
            components: [
              historyHeaderComponent, // <-- Use the conditionally built component
              {
                type: 14,
                spacing: 1,
                divider: true
              },
              {
                type: 10,
                content: "**Last months**\n" + monthlyStats.map(s => `**\`${s.name}\`** - **${formatNumber(s.plays)}** plays - **${s.time}**`).join("\n")
              }
            ]
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: "profile",
                style: 2,
                label: "Profile",
                emoji: { name: "ℹ️" }
              },
              {
                type: 2,
                style: 5,
                label: "Last.fm",
                url: lastfmUrl,
                emoji: { id: "882227627287515166", name: "services_lastfm" }
              }
            ]
          }
        ];
        await btnInt.editReply({ content: "", embeds: [], components: historyComponents, flags: 32768 });
      } else if (btnInt.customId === "profile") {
        await btnInt.editReply({ content: "", embeds: [], components: profileComponents, flags: 32768 });
      }
    });

    collector.on("end", async () => {
      try {
        await sent.edit({ components: [] });
      } catch {}
    });

  } catch (err) {
    console.error("Profile command error:", err);
    await interaction[replyMethod]({ content: "❌ Failed to fetch stats." });
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}