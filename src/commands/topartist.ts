// src/commands/topartist.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  Message, // <--- FIXED: Added Message
  TextChannel, // <--- ADDED: For prefix command typing
} from "discord.js";
import fetch, { FetchError } from "node-fetch";
import { CanvasRenderingContext2D, createCanvas, loadImage, registerFont } from "canvas";
import path from "path";
import { getUser } from "../scripts/storage";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";
import FormData from "form-data"; // <--- ADDED: For hidden upload
import dotenv from "dotenv";

dotenv.config();

// --- REGISTER CUSTOM FONT ---
const fontPath = path.join(__dirname, '../../fonts/Metropolis-SemiBold.otf');
registerFont(fontPath, { family: "Metropolis" });
// --- END FONT REGISTRATION ---


// --- ADDED: Consistent color from chart.ts ---
const FM_COLOR = 12189696;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;

// ------------------------------------------------------------------
// ADDED: HELPER FUNCTION FOR UPLOADING (from chart.ts)
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
    form.append('file', buffer, 'topartist-chart.png'); // Renamed file

    const res = await fetch(
      `https://discord.com/api/v10/channels/${UPLOAD_CHANNEL_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${TOKEN}`,
          ...form.getHeaders(),
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
    
    console.log("Uploaded artist chart to hidden channel:", imageUrl);
    return imageUrl;

  } catch (err) {
    console.error("Hidden upload failed:", err);
    return null;
  }
}
// ------------------------------------------------------------------


interface LastFmImage {
  '#text': string;
  size: 'small' | 'medium' | 'large' | 'extralarge';
}

interface LastFmTopArtist {
  name: string;
  playcount: string;
  url: string;
  mbid: string;
  image: LastFmImage[];
}

interface ArtistChartItem {
  name: string;
  img: string;
  playcount: string;
}

let spotifyToken: string | null = null;
let tokenExpiryTime: number = 0;

async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("❌ Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env");
  }

  if (spotifyToken && Date.now() < tokenExpiryTime - 60000) {
    return spotifyToken;
  }

  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Spotify token fetch failed: ${errText}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  spotifyToken = data.access_token;
  tokenExpiryTime = Date.now() + data.expires_in * 1000;

  return spotifyToken;
}

async function findArtistImageUrlFromSpotify(artistName: string, token: string): Promise<string> {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return "";
    const data = (await res.json()) as any;
    const artist = data?.artists?.items?.[0];
    return artist?.images?.[0]?.url ?? "";
  } catch {
    return "";
  }
}

// ──────────────────────────────────────────────────────────────
// NEW: Smart text truncation function (from chart.ts)
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
// UPDATED: Drawing function with text (from chart.ts)
// ──────────────────────────────────────────────────────────────
async function drawArtistWithText(
  ctx: CanvasRenderingContext2D,
  artistItem: ArtistChartItem,
  x: number,
  y: number,
  size: number
) {
  const half = size / 2;

  // Draw cover (or fallback gray box)
  if (!artistItem.img) {
    ctx.fillStyle = "#222";
    ctx.fillRect(x, y, size, size);
  } else {
    try {
      const buf = await fetch(artistItem.img).then(r => r.arrayBuffer());
      const img = await loadImage(Buffer.from(buf));
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = "high";
      ctx.drawImage(img, x, y, size, size);
    } catch (err) {
      console.warn(`Failed to load image for ${artistItem.name}:`, err);
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
  const titleFontSize = 18;
  const titleFont = `${titleFontSize}px "Metropolis", sans-serif`;

  const sideMargin = 10;
  const textPadding = 15;
  const maxWidth = size - (sideMargin * 2) - (textPadding * 2);

  // ── 2. Measure & Truncate Text ──
  ctx.font = titleFont;
  // Use artistItem.name for the title
  const title = truncateText(ctx, artistItem.name, maxWidth);
  const titleMetrics = ctx.measureText(title);

  // ── 3. Calculate DYNAMIC Box Size ──
  const horizPadding = 10;
  const vertPadding = 8;
  const bottomMargin = 0;
  const cornerRadius = 6;

  const boxWidth = titleMetrics.width + (horizPadding * 2);
  const boxHeight = titleFontSize + (vertPadding * 2);

  const boxX = x + half - (boxWidth / 2);
  const boxY = y + size - bottomMargin - boxHeight;

  // ── 4. Draw Rounded Box ──
  ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.30)" : "rgba(0,0,0,0.30)";
  ctx.beginPath();
  // Check if roundRect exists, otherwise use a plain rect
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, cornerRadius);
  } else {
    ctx.rect(boxX, boxY, boxWidth, boxHeight);
  }
  ctx.fill();

  // ── 5. Draw Text ──
  ctx.fillStyle = isDark ? "#0c0c0cff" : "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  const textX = x + half;
  const titleY = boxY + vertPadding;

  // Draw Artist Name
  ctx.font = titleFont;
  ctx.fillText(title, textX, titleY);
  
  // Reset shadow
  ctx.shadowColor = "transparent";
  ctx.textBaseline = "alphabetic";
}

export const data = new SlashCommandBuilder()
  .setName("top")
  .setDescription("Generate your Last.fm top artist chart.")
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
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // --- ADDED: Prefix/Slash handling ---
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
    return interaction.reply({
      content: "❌ You haven’t linked your Last.fm account yet. Use `/link` first.",
      ephemeral: true,
    });
  }

  // --- MODIFIED: Conditional defer and reply method ---
  if (!isPrefix) await interaction.deferReply();
  const replyMethod = isPrefix ? "reply" : "editReply";
  // ---

  const { username } = linkedUser;
  // --- MODIFIED: Get realName from interaction (provided by adapter) ---
  const realName = interaction.user.displayName;
  // ---

  const apiKey = process.env.LASTFM_API_KEY!;
  // --- ADDED: Robust period normalization (from chart.ts) ---
const userInput = (interaction.options.getString("period") ?? "7day").toLowerCase();
let period: string;

if (userInput.includes("week") || userInput.includes("7day")) {
  period = "7day";
} else if (userInput.includes("month") && !userInput.includes("3") && !userInput.includes("6") && !userInput.includes("12")) {
  period = "1month";
} else if (userInput.includes("3month") || userInput.includes("3 month")) {
  period = "3month";
} else if (userInput.includes("6month") || userInput.includes("6 month")) {
  period = "6month";
} else if (userInput.includes("year") || userInput.includes("12month") || userInput.includes("12 month")) {
  period = "12month";
} else if (userInput.includes("overall")) {
  period = "overall";
} else {
  // Default to 7day if input is unrecognized (like "daily" which this chart doesn't support)
  period = "7day";
}
// --- END NORMALIZATION ---
  const limit = 9;

  try {
    const token = await getSpotifyAccessToken();

    const artistApiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${encodeURIComponent(
      username
    )}&period=${period}&limit=${limit}&api_key=${apiKey}&format=json`;

    const [artistRes, userRes] = await Promise.all([
      fetch(artistApiUrl),
      fetch(
        `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(
          username
        )}&api_key=${apiKey}&format=json`
      ),
    ]);

    const artistData = (await artistRes.json()) as { topartists: { artist?: LastFmTopArtist[] } };
    const userData = (await userRes.json()) as any;
    const totalScrobbles = parseInt(userData?.user?.playcount ?? "0").toLocaleString();

    let artistsDataRaw = artistData?.topartists?.artist ?? [];

    const artistsWithImagePromises = artistsDataRaw.map(async (a) => {
      const imageUrl = await findArtistImageUrlFromSpotify(a.name, token);
      return {
        name: a.name,
        playcount: parseInt(a.playcount).toLocaleString(),
        img: imageUrl,
      };
    });

    let artists: ArtistChartItem[] = await Promise.all(artistsWithImagePromises);
    artists = artists.filter((a) => a.name !== "(null)"); // Filter out bad data

    if (artists.length === 0) {
      return interaction[replyMethod]({
        content: `❌ Could not find any scrobbled artists for **${username}** in that period.`,
      });
    }

    // --- MODIFIED: Dynamic grid size ---
    let gridSize = 3;
    const artistCount = artists.length;
    if (artistCount < 4) gridSize = 1;
    else if (artistCount < 9) gridSize = 2;

    const actualCount = Math.min(artistCount, gridSize * gridSize);
    const cell = 300; // Keep cell size 300
    const canvasSize = cell * gridSize; // Canvas size adapts
    // ---

    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext("2d");

    // --- MODIFIED: Use new 'actualCount' and 'gridSize' ---
    const imagePromises = artists.slice(0, actualCount).map(async (artist, i) => {
      const x = (i % gridSize) * cell;
      const y = Math.floor(i / gridSize) * cell;
      
      // Call the new drawing function
      return drawArtistWithText(ctx, artist, x, y, cell);
    });
    // ---

    await Promise.all(imagePromises);

    // ── MODIFIED: New Component-Based Reply ──
    const buffer = canvas.toBuffer("image/png");

    // --- STEP 1: UPLOAD TO HIDDEN CHANNEL ---
    const imageUrl = await uploadToHiddenChannel(buffer);
    
    if (!imageUrl) {
      console.error("Failed to get image URL from hidden upload.");
      await interaction[replyMethod]({ content: "❌ Failed to upload chart image." });
      return;
    }
    
    if (isPrefix) await new Promise(r => setTimeout(r, 2000));

    // --- STEP 2: BUILD COMPONENT STRINGS ---
    const periodMap: Record<string, string> = {
      "7day": "Weekly", "1month": "Monthly", "3month": "Quarterly",
      "6month": "Half-Yearly", "12month": "Yearly", "overall": "Overall",
    };
    
    const userUrl = `https://www.last.fm/user/${encodeURIComponent(username)}`;
    const sizeText = `${gridSize}x${gridSize}`;

    const contentString = `**[${sizeText} ${periodMap[period]} Artist Chart](${userUrl}) for ${realName}**\n-# ${username} has **${totalScrobbles}** scrobbles`;
    
    const descriptionString = artists
      .slice(0, actualCount)
      .map((artist, idx) => `#${idx + 1} ${artist.name} (${artist.playcount} plays)`)
      .join(', ');

    // --- STEP 3: BUILD AND SEND FINAL PAYLOAD (NO EDIT!) ---
    const messageData: any = {
      content: "",
      embeds: [],
      files: [], 
      components: [
        {
          type: 17, // Container
          accent_color: FM_COLOR, // <-- Use the constant
          spoiler: false,
          components: [
            {
              type: 12, // Gallery
              items: [
                {
                  media: { url: imageUrl }, 
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
    // --- END MODIFICATION ---

  } catch (err) {
    console.error(err);
    // --- MODIFIED: Use replyMethod and clear components ---
    await interaction[replyMethod]({
      content: "❌ Something went wrong while generating your top artist chart.",
      embeds: [],
      files: [],
      components: []
    });
    // ---
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}