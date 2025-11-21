// src/commands/link.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  TextChannel,
} from "discord.js";
import fetch from "node-fetch";
import { createInteractionFromMessage } from "../scripts/prefixAdapter";

// We use the env variables directly
const API_KEY = process.env.LASTFM_API_KEY;

export const data = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link your Last.fm account to the bot.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const isPrefix = (interaction as any).isPrefix;
  
  // Handle typing/deferring
  if (isPrefix) {
    try {
      (interaction.channel as TextChannel).sendTyping();
    } catch {}
  } else {
    // We use ephemeral so only the user sees their login link
    await interaction.deferReply({ ephemeral: true });
  }

  const replyMethod = isPrefix ? "reply" : "editReply";

  if (!API_KEY) {
    await interaction[replyMethod]("❌ Bot configuration error: LASTFM_API_KEY is missing.");
    return;
  }

  try {
    // 1. Get a Request Token from Last.fm (No signature required for this step)
    const tokenUrl = `https://ws.audioscrobbler.com/2.0/?method=auth.gettoken&api_key=${API_KEY}&format=json`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as any;

    if (!tokenData.token) {
      throw new Error(`No token received from Last.fm. Error: ${JSON.stringify(tokenData)}`);
    }

    const token = tokenData.token;

    // 2. Construct the User Approval URL
    // This is the link the user clicks to say "Yes, I allow this bot"
    const authUrl = `https://www.last.fm/api/auth/?api_key=${API_KEY}&token=${token}`;

    // 3. Create the response Embed
    const embed = new EmbedBuilder()
      .setColor(0xd51007)
      .setTitle("Connect your Last.fm Account")
      .setDescription(
        "To link your account, follow these steps:\n\n" +
        "1. Click **Login with Last.fm** below.\n" +
        "2. Click **'Yes, Allow Access'** in the browser window.\n" +
        "3. Come back here and click **'Verify Login'**."
      )
      .setFooter({ text: "This link expires in 60 minutes." });

    // 4. Create Buttons
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Login with Last.fm")
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl), // Points to Last.fm website
      new ButtonBuilder()
        .setCustomId(`verify_login:${token}`) // We store the token in the button ID
        .setLabel("Verify Login")
        .setStyle(ButtonStyle.Success)
    );

    await interaction[replyMethod]({ embeds: [embed], components: [row] });

  } catch (err) {
    console.error("Link command failed:", err);
    await interaction[replyMethod]("❌ Failed to contact Last.fm. Please try again later.");
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}