// src/commands/chart.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  Message,
  TextChannel,
} from "discord.js";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import fetch, { FetchError } from "node-fetch";
import { CanvasRenderingContext2D, createCanvas, loadImage, registerFont } from "canvas";
import { getUser } from "../scripts/storage";
import dotenv from "dotenv";
import path from "path";
import FormData from "form-data"; 

dotenv.config();

// --- REGISTER CUSTOM FONT ---
const fontPath = path.join(__dirname, '../../fonts/Metropolis-SemiBold.otf');
registerFont(fontPath, { family: "Metropolis" });
// --- END FONT REGISTRATION ---

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const FM_COLOR = 0xd51007; // <-- ADDED CONSTANT

// ------------------------------------------------------------------
// NEW HELPER FUNCTION FOR UPLOADING
// ------------------------------------------------------------------
async function uploadToHiddenChannel(buffer: Buffer): Promise<string | null> {
  const TOKEN = process.env.DISCORD_TOKEN!;
  const UPLOAD_CHANNEL_ID = process.env.DISCORD_UPLOAD_CHANNEL_ID!;
  
  if (!UPLOAD_CHANNEL_ID) {
    console.error("DISCORD_UPLOAD_CHANNEL_ID is not set in .env file.");
    return null;
  }
  
  try {
    const form = new FormData();
    // 'file' is the field name Discord's API expects for attachments
    form.append('file', buffer, 'chart.png');

    const res = await fetch(
      `https://discord.com/api/v10/channels/${UPLOAD_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${TOKEN}`,
          ...form.getHeaders(), // This is crucial for form-data
        },
        body: form,
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to upload to hidden channel: ${res.status} ${error}`);
    }

    const message = (await res.json()) as any;
    const imageUrl = message.attachments?.[0]?.url;

    if (!imageUrl) {
      throw new Error("Upload to hidden channel succeeded but no attachment URL was returned.");
    }
    
    console.log("Uploaded image to hidden channel:", imageUrl);
    return imageUrl;

  } catch (err) {
    console.error("Hidden upload failed:", err);
    return null;
  }
}
// ------------------------------------------------------------------

interface LastFmImage {
  "#text": string;
  size: "small" | "medium" | "large" | "extralarge" | "mega";
}

// This is the common structure our functions must return
interface LastFmTopAlbum {
  name: string;
  playcount: string; // Keep as string to match original API
  url: string;
  artist: { name: string; url: string };
  image: LastFmImage[];
}

interface AlbumChartItem {
  name: string;
  artist: string;
  img: string;
}

export const data = new SlashCommandBuilder()
  .setName("chart")
  .setDescription("Generate your Last.fm album chart.")
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Time period")
      .setRequired(false)
      .addChoices(
        { name: "Daily", value: "1day" },
        { name: "7 days", value: "7day" },
        { name: "1 month", value: "1month" },
        { name: "3 months", value: "3month" },
        { name: "6 months", value: "6month" },
        { name: "12 months", value: "12month" },
        { name: "Overall", value: "overall" }
      )
  );

// --- FIX: REAL SPOTIFY URLS ---
async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function searchSpotifyCover(artist: string, album: string): Promise<string | null> {
  try {
    const accessToken = await getSpotifyAccessToken();
    const query = encodeURIComponent(`artist:${artist} album:${album}`);
    // --- FIX: REAL SPOTIFY URL ---
    const res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=album&limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // --- END FIX ---

    const data = (await res.json()) as {
      albums?: { items?: { images?: { url: string }[] }[] };
    };

    const cover = data.albums?.items?.[0]?.images?.[0]?.url || null;
    return cover;
  } catch (err) {
    console.warn("Spotify cover search failed:", err);
    return null;
  }
}
// --- END URL FIXES ---

async function fetchDeezerCover(artist: string, album: string): Promise<string | null> {
  try {
    const query = encodeURIComponent(`artist:"${artist}" album:"${album}"`);
    const res = await fetch(`https://api.deezer.com/search/album?q=${query}&limit=1`);
    const data = await res.json() as any;
    return data.data?.[0]?.cover_xl || data.data?.[0]?.cover_big || null;
  } catch (err) {
    console.warn("Deezer cover search failed:", err);
    return null;
  }
}

// --- THIS IS THE ORIGINAL FUNCTION FOR 7DAY+ ---
async function getStandardTopAlbums(username: string, period: string, sessionKey: string): Promise<LastFmTopAlbum[]> {
  let url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&format=json&period=${period}&limit=9`;
  if (sessionKey) {
    url += `&sk=${sessionKey}`;
  }
  try {
    const res = await fetch(url);
    const data = await res.json() as any;
    if (data.error) {
      console.error(`Last.fm error for top albums: ${data.message}`);
      return [];
    }
    return data.topalbums?.album || [];
  } catch (err) {
    console.error("Last.fm standard top albums fetch failed:", err);
    return [];
  }
}

// --- UPDATED: ROBUST DAILY FUNCTION WITH CLIENT-SIDE FILTER AND AUTH ---
async function buildDailyTopAlbums(username: string, sessionKey: string): Promise<LastFmTopAlbum[]> {
  const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;  // 24h window
  const allTracks: any[] = [];
  let currentPage = 1;
  const maxPages = 5;  // Safety: ~1000 tracks max, daily won't need more

  console.log(`[DEBUG] Fetching recent tracks (client-filtered to last 24h). From: ${new Date(twentyFourHoursAgo * 1000).toISOString()}`);

  try {
    // Paginate recenttracks WITHOUT &from= — gets newest first
    do {
      let url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&format=json&limit=200&page=${currentPage}`;
      if (sessionKey) {
        url += `&sk=${sessionKey}`;
      }
      
      console.log(`[DEBUG] Fetching page ${currentPage}: ${url}`);  // For manual testing
      
      const res = await fetch(url);
      const data = (await res.json()) as any;

      if (data.error) {
        console.error(`Last.fm error for recent tracks: ${data.message}`);
        break;
      }

      if (!data.recenttracks) {
        break;
      }

      let tracks = data.recenttracks.track || [];
      if (tracks && !Array.isArray(tracks)) {
        tracks = [tracks];
      }

      // Stop early if last track is older than 24h
      const lastTrackTime = tracks[tracks.length - 1]?.date?.uts;
      if (lastTrackTime && parseInt(lastTrackTime) < twentyFourHoursAgo && allTracks.length > 0) {
        console.log(`[DEBUG] Stopped paginating: Last track (${new Date(lastTrackTime * 1000).toISOString()}) older than window.`);
        break;
      }

      allTracks.push(...tracks);
      currentPage++;

    } while (currentPage <= maxPages);

    console.log(`[DEBUG] Total recent scrobbles fetched (unfiltered): ${allTracks.length}`);

    if (allTracks.length === 0) {
      return []; // No tracks at all
    }

    // Filter to only tracks within 24h, then count albums
    const recentTracks = allTracks.filter(track => {
      const trackTime = parseInt(track.date?.uts || '0');
      return trackTime >= twentyFourHoursAgo;
    });

    console.log(`[DEBUG] Scrobbles in last 24h after filter: ${recentTracks.length}`);
    if (recentTracks.length > 0) {
      console.log('[DEBUG] Sample recent track:', JSON.stringify(recentTracks[0], null, 2));
    }

    if (recentTracks.length === 0) {
      return []; // None in window
    }

    // Rest unchanged: Count albums from recentTracks
    const albumCounts = new Map<string, { name: string; artist: string; plays: number }>();
    let processedTracks = 0;
    
    for (const track of recentTracks) {
      const albumName = track.album?.["#text"];
      const artistName = track.artist?.["#text"];
      if (track["@attr"]?.nowplaying) continue;  // Skip now playing

      if (!albumName || !artistName) {
        console.log(`[DEBUG] Skipping track "${track.name}" by "${artistName || 'unknown'}" - missing album/artist`);
        continue;
      }

      const key = `${artistName}|${albumName}`.toLowerCase();

      if (albumCounts.has(key)) {
        albumCounts.get(key)!.plays++;
      } else {
        albumCounts.set(key, {
          name: albumName,
          artist: artistName,
          plays: 1,
        });
      }
      processedTracks++;
    }
    
    console.log(`[DEBUG] Processed ${processedTracks} valid scrobbles with albums. Unique albums: ${albumCounts.size}`);

    // Sort and format with Last.fm fallback
    const sortedAlbums = Array.from(albumCounts.values())
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 9);

    const topAlbums: LastFmTopAlbum[] = await Promise.all(
      sortedAlbums.map(async (album) => {
        const images: LastFmImage[] = [
          { "#text": "", size: "small" },
          { "#text": "", size: "medium" },
          { "#text": "", size: "large" },
          { "#text": "", size: "extralarge" },
        ];

        let imgUrl = "";

        // +++ NEW ORDER: 1. Spotify +++
        try {
          console.log(`[DEBUG] Trying Spotify for ${album.name}...`);
          imgUrl = await searchSpotifyCover(album.artist, album.name) || "";
        } catch (e) {
          console.warn(`Spotify art fetch failed for ${album.name}:`, e);
        }
        
        // +++ NEW ORDER: 2. Deezer +++
        if (!imgUrl) {
          try {
            console.log(`[DEBUG] Spotify failed for ${album.name}, trying Deezer...`);
            imgUrl = await fetchDeezerCover(album.artist, album.name) || "";
          } catch (e) {
            console.warn(`Deezer art fetch failed for ${album.name}:`, e);
          }
        }

        // +++ NEW ORDER: 3. Last.fm +++
        if (!imgUrl) {
          console.log(`[DEBUG] Deezer failed for ${album.name}, trying Last.fm...`);
          let url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(album.artist)}&album=${encodeURIComponent(album.name)}&format=json`;
          if (sessionKey) {
            url += `&sk=${sessionKey}`;
          }
          try {
            const res = await fetch(url);
            const data = await res.json() as any;
            if (data.album?.image) {
              imgUrl = data.album.image.find((i: LastFmImage) => i.size === "extralarge")?.["#text"] || "";
            }
          } catch (e) {
            console.warn(`Last.fm album info failed for ${album.name}:`, e);
          }
        }

        if (imgUrl) {
          images.forEach(img => img["#text"] = imgUrl);
        }

        const artistUrl = `https://www.last.fm/music/${encodeURIComponent(album.artist)}`;
        const albumUrl = `${artistUrl}/${encodeURIComponent(album.name)}`;

        return {
          name: album.name,
          playcount: String(album.plays),
          url: albumUrl,
          artist: { name: album.artist, url: artistUrl },
          image: images,
        };
      })
    );

    return topAlbums;

  } catch (err) {
    console.error("Last.fm daily top albums build failed:", err);
    return [];
  }
}

async function getUserScrobbleCount(username: string, sessionKey: string): Promise<number> {
  let url = `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(username)}&api_key=${LASTFM_API_KEY}&format=json`;
  if (sessionKey) {
    url += `&sk=${sessionKey}`;
  }
  try {
    const res = await fetch(url);
    const data = await res.json() as any;
    if (data.error) {
      console.error(`Last.fm error for user info: ${data.message}`);
      return 0;
    }
    return Number(data.user?.playcount) || 0;
  } catch (err) {
    console.error("Scrobble count fetch failed:", err);
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────
// NEW: Smart text truncation function
// ──────────────────────────────────────────────────────────────
/**
 * Truncates text to a maximum pixel width, adding an ellipsis if needed.
 */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let truncated = text;
  while (ctx.measureText(truncated + "…").width > maxWidth && truncated.length > 1) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + "…";
}

// ──────────────────────────────────────────────────────────────
// UPDATED: Brightness, Rounded Rects, and Font Fix
// ──────────────────────────────────────────────────────────────
async function drawAlbumWithText(
  ctx: CanvasRenderingContext2D,
  album: AlbumChartItem,
  x: number,
  y: number,
  size: number
) {
  const half = size / 2;

  // Draw cover (or fallback gray box)
  if (!album.img) {
    ctx.fillStyle = "#222";
    ctx.fillRect(x, y, size, size);
  } else {
    try {
      const buf = await fetch(album.img).then(r => r.arrayBuffer());
      const img = await loadImage(Buffer.from(buf));
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = "high";
      ctx.drawImage(img, x, y, size, size);
    } catch (err) {
      console.warn(`Failed to load image for ${album.name}:`, err);
      ctx.fillStyle = "#222";
      ctx.fillRect(x, y, size, size);
    }
  }

  // ── Brightness detection ──
  const sampleSize = Math.min(100, size);
  const sampleX = x + half - (sampleSize / 2);
  const sampleY = y + half - (sampleSize / 2);

  const imageData = ctx.getImageData(sampleX, sampleY, sampleSize, sampleSize);
  let brightness = 0;
  for (let i = 0; i < imageData.data.length; i += 4) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    brightness += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  brightness /= imageData.data.length / 4;
  const isDark = brightness < 110;

  // ── 1. Define Text & Styles ──
  // --- FIX: Use "Metropolis" font family ---
  const titleFontSize = 18;
  const artistFontSize = 14;
  // --- FIX: Removed 'bold' to use the registered SemiBold file directly ---
  const titleFont = `${titleFontSize}px "Metropolis", sans-serif`;
  const artistFont = `${artistFontSize}px "Metropolis", sans-serif`;

  const sideMargin = 10;
  const textPadding = 15;
  const maxWidth = size - (sideMargin * 2) - (textPadding * 2);

  // ── 2. Measure & Truncate Text ──
  ctx.font = titleFont;
  const title = truncateText(ctx, album.name, maxWidth);
  const titleMetrics = ctx.measureText(title);

  ctx.font = artistFont;
  const artist = truncateText(ctx, album.artist, maxWidth);
  const artistMetrics = ctx.measureText(artist);

  // ── 3. Calculate DYNAMIC Box Size ──
  const horizPadding = 10;
  const vertPadding = 8;
  const textGap = 4;
  const bottomMargin = 0; // Your change
  const cornerRadius = 6;

  const boxWidth = Math.max(titleMetrics.width, artistMetrics.width) + (horizPadding * 2);
  const boxHeight = titleFontSize + artistFontSize + textGap + (vertPadding * 2);

  const boxX = x + half - (boxWidth / 2);
  const boxY = y + size - bottomMargin - boxHeight;     

  // ── 4. Draw Rounded Box ──
  ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.30)" : "rgba(0,0,0,0.30)";
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxWidth, boxHeight, cornerRadius);
  ctx.fill();

  // ── 5. Draw Text ──
  ctx.fillStyle = isDark ? "#0c0c0cff" : "#fff"; // Your change
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0,0,0,0.3)"; // Your change
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  const textX = x + half;
  const titleY = boxY + vertPadding;
  const artistY = titleY + titleFontSize + textGap;

  // Draw Album Name
  ctx.font = titleFont;
  ctx.fillText(title, textX, titleY);
  
  // Draw Artist Name
  ctx.font = artistFont;
  ctx.fillText(artist, textX, artistY);

  // Reset shadow
  ctx.shadowColor = "transparent";
  ctx.textBaseline = "alphabetic";
}

// ──────────────────────────────────────────────────────────────
// MAIN EXECUTE (UPDATED FOR SINGLE-SEND)
// ──────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch (err) {
      console.warn("Typing indicator failed:", err);
    }
  }

  // --- Only defer slash commands ---
  if (!isPrefix) await interaction.deferReply();

  // --- We need a way to reply, so we choose the method early ---
  const replyMethod = isPrefix ? "reply" : "editReply";

  try {
    const userData = getUser(interaction.user.id);
    if (!userData) {
      await interaction[replyMethod]("❌ No linked account. Use `/link` first.");
      return;
    }

    const { username, sessionKey } = userData;
    const realName = interaction.user.displayName;

    // +++ THIS IS THE LOGIC FOR PREFIX + DAILY +++
    const userInput = (interaction.options.getString("period") || "overall").toLowerCase();
    let period: string;

    if (userInput.includes("daily") || userInput.includes("day") || userInput.includes("1day")) {
      period = "1day";
    } 
    else if (userInput.includes("week") || userInput.includes("7day")) {
      period = "7day";
    } else if (userInput.includes("month") && !userInput.includes("3") && !userInput.includes("6") && !userInput.includes("12")) {
      period = "1month";
    } else if (userInput.includes("3month") || userInput.includes("3 month")) {
      period = "3month";
    } else if (userInput.includes("6month") || userInput.includes("6 month")) {
      period = "6month";
    } else if (userInput.includes("year") || userInput.includes("12month") || userInput.includes("12 month")) {
      period = "12month";
    } else {
      period = "overall";
    }
    // +++ END LOGIC +++

    // --- NEW LOGIC: CHOOSE THE RIGHT FUNCTION ---
    let topAlbums: LastFmTopAlbum[];
    if (period === "1day") {
      console.log(`Building daily chart for ${username}...`);
      topAlbums = await buildDailyTopAlbums(username, sessionKey);
    } else {
      console.log(`Fetching ${period} chart for ${username}...`);
      topAlbums = await getStandardTopAlbums(username, period, sessionKey);
    }
    // --- END NEW LOGIC ---

    const totalScrobbles = await getUserScrobbleCount(username, sessionKey);

    if (topAlbums.length === 0) {
      await interaction[replyMethod]("❌ No scrobbles found in this period. Listen to some full tracks and try again later!");
      return;
    }

    // Dynamic grid (still 3×3 max, but smaller grids if <9)
    let gridSize = 3;
    const albumCount = topAlbums.length;
    if (albumCount < 4) gridSize = 1;
    else if (albumCount < 9) gridSize = 2;

    const actualCount = Math.min(albumCount, gridSize * gridSize);
    const canvasSize = 900;
    const cell = canvasSize / gridSize;

    console.log(`[DEBUG] Using ${gridSize}x${gridSize} grid (${canvasSize}px) for ${actualCount} albums.`);

    const albums: AlbumChartItem[] = await Promise.allSettled(
      topAlbums.slice(0, actualCount).map(async (album: LastFmTopAlbum) => {
        let img: string | null = null;

        img = await searchSpotifyCover(album.artist.name, album.name).catch(() => null);
        if (!img) img = await fetchDeezerCover(album.artist.name, album.name).catch(() => null);
        if (!img) {
          const lastFmImg = album.image?.find((i: LastFmImage) => i.size === "extralarge")?.["#text"] || null;
          const isPlaceholder = lastFmImg && (lastFmImg.includes("2a96cbd8b46e442fc41c2b86b821562f.png") || lastFmImg === "");
          img = isPlaceholder ? null : lastFmImg;
        }

        return { name: album.name, artist: album.artist.name, img: img || "" };
      })
    ).then(results =>
      results
        .filter((r): r is PromiseFulfilledResult<AlbumChartItem> => r.status === "fulfilled")
        .map(r => r.value)
    );

    // ── Canvas setup ──
    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext("2d");

    // Background
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // Draw albums with smart text
    const drawPromises = albums.map((album, idx) => {
      const col = idx % gridSize;
      const row = Math.floor(idx / gridSize);
      const posX = col * cell;
      const posY = row * cell;
      return drawAlbumWithText(ctx, album, posX, posY, cell);
    });

    await Promise.all(drawPromises);

    // ── New Component-Based Reply (Single Step) ──
    const buffer = canvas.toBuffer("image/png");

    // --- STEP 1: UPLOAD TO HIDDEN CHANNEL ---
    const imageUrl = await uploadToHiddenChannel(buffer);
    
    if (!imageUrl) {
      console.error("Failed to get image URL from hidden upload.");
      await interaction[replyMethod]({ content: "❌ Failed to upload chart image." });
      return;
    }
    
    if (isPrefix) await new Promise(r => setTimeout(r, 2000)); // Shorter delay, just for safety

    // --- STEP 2: BUILD COMPONENT STRINGS ---
    const descriptionString = albums
      .map((album, idx) => `#${idx + 1} ${album.name} by ${album.artist}`)
      .join(', ');

    const periodMap: Record<string, string> = {
      "1day": "Daily", "7day": "Weekly", "1month": "Monthly",
      "3month": "3-Month", "6month": "6-Month", "12month": "Yearly",
      overall: "All-Time",
    };

    const periodPresetMap: Record<string, string> = {
      "1day": "LAST_24_HOURS", "7day": "LAST_7_DAYS", "1month": "LAST_30_DAYS",
      "3month": "LAST_90_DAYS", "6month": "LAST_180_DAYS", "12month": "LAST_365_DAYS",
      "overall": "ALL",
    };
    
    const sizeText = `${gridSize}x${gridSize}`;
    const chartUrl = `https://www.last.fm/user/${encodeURIComponent(username)}/library/albums?date_preset=${periodPresetMap[period]}`;
    const contentString = `**[${sizeText} ${periodMap[period]} Chart](${chartUrl}) for ${realName}**\n-# ${username} has **${totalScrobbles.toLocaleString()}** scrobbles${albumCount < 9 ? `\n-# Found ${actualCount} unique album${actualCount > 1 ? 's' : ''} in period` : ''}`;

    // --- STEP 3: BUILD AND SEND FINAL PAYLOAD (NO EDIT!) ---
    const messageData: any = {
      content: "",
      embeds: [],
      files: [], // No files needed here anymore
      components: [
        {
          type: 17, // Container
          accent_color: 12189696, // <-- USE THE CONSTANT
          spoiler: false,
          components: [
            {
              type: 12, // Gallery
              items: [
                {
                  media: { url: imageUrl }, // Use the URL we just got
                  description: descriptionString,
                  spoiler: false
                }
              ]
            },
            {
              type: 10, // Text
              content: contentString
            }
          ]
        }
      ],
      flags: 32768
    };
    
    await interaction[replyMethod](messageData); // Send the final message
    
    console.log(`✅ ${periodMap[period]} chart sent! (single-send)`);

  } catch (err: any) {
    if (err instanceof FetchError || err.name === "AbortError" || err.message?.includes("This operation was aborted")) {
      console.warn("⚠️ Discord/Fetch aborted the response after success — safe to ignore.");
      console.log("✅ Chart sent successfully (post-abort).");
      return;
    }

    console.error("🔥 Chart generation failed:", err);

    if (interaction.replied || interaction.deferred || isPrefix) {
      try {
        await interaction[replyMethod]({
          content: "❌ Failed to generate chart. Try again later.",
          embeds: [], files: [], components: []
        });
      } catch { /* Ignore */ }
    } else {
      await interaction.reply({
        content: "❌ Failed to generate chart. Try again later.",
        ephemeral: true,
      });
    }
  }
}

// ──────────────────────────────────────────────────────────────
// PREFIX EXECUTE
// ──────────────────────────────────────────────────────────────
export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}