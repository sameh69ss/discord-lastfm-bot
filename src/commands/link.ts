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
    // We use ephemeral so the fallback message in the channel is private if possible
    await interaction.deferReply({ ephemeral: true });
  }

  // Helper for simple string replies
  const replyString = async (content: string) => {
    if (isPrefix) {
        await (interaction as any).reply(content);
    } else {
        await interaction.editReply(content);
    }
  };

  if (!API_KEY) {
    await replyString("❌ Bot configuration error: LASTFM_API_KEY is missing.");
    return;
  }

  try {
    // 1. Get a Request Token from Last.fm
    const tokenUrl = `https://ws.audioscrobbler.com/2.0/?method=auth.gettoken&api_key=${API_KEY}&format=json`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as any;

    if (!tokenData.token) {
      throw new Error(`No token received from Last.fm. Error: ${JSON.stringify(tokenData)}`);
    }

    const token = tokenData.token;

    // 2. Construct the User Approval URL
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
      .setFooter({ text: "This link expires in 10 minutes." });

    // 4. Create Buttons
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Login with Last.fm")
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl),
      new ButtonBuilder()
        .setCustomId(`verify_login:${token}`)
        .setLabel("Verify Login")
        .setStyle(ButtonStyle.Success)
    );

    // 5. Attempt to Send DM
    let sentInDm = false;
    try {
        await interaction.user.send({ embeds: [embed], components: [row] });
        sentInDm = true;
    } catch (dmError) {
        // This usually happens if the user has DMs closed
        sentInDm = false;
    }

    // 6. Respond based on where the message went
    if (sentInDm) {
        // Success: The login is in their DMs
        await replyString("📩 Check your DMs for the Last.fm login link!");
    } else {
        // Failure: DMs are closed, so we send the login message to the channel instead
        const content = "⚠️ I couldn't DM you, so here is the link:";
        
        if (isPrefix) {
             await (interaction as any).reply({ content, embeds: [embed], components: [row] });
        } else {
             // For slash commands, this will still be ephemeral (only they can see it)
             await interaction.editReply({ content, embeds: [embed], components: [row] });
        }
    }

  } catch (err) {
    console.error("Link command failed:", err);
    await replyString("❌ Failed to contact Last.fm. Please try again later.");
  }
}

export async function prefixExecute(message: Message, args: string[]) {
  const interaction = createInteractionFromMessage(message, args);
  await execute(interaction as any);
}