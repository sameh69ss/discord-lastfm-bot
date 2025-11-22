// src/handlers/previewHandler.ts
import { ButtonInteraction } from "discord.js";
import fs from "fs";
import fsp from "fs/promises";
import { downloadAndConvert } from "../scripts/downloader";
import sendVoice from "../scripts/sendVoice";
import { previewMap } from "../index"; // You might need to move previewMap to a shared state file if you want to avoid import cycles fully, but this is okay for now.

export async function handlePreview(interaction: ButtonInteraction, originalInteractionId: string) {
  const previewUrl = previewMap.get(originalInteractionId);
  
  if (!previewUrl) {
    await interaction.reply({ content: "Preview expired or missing.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  let oggPath: string | null = null;

  try {
    oggPath = await downloadAndConvert(previewUrl, originalInteractionId);
    await sendVoice(interaction.channelId, oggPath, interaction.message.id);
  } catch (err) {
    console.error("Voice preview failed:", err);
    await interaction.followUp({ content: "Failed to retrieve preview.", ephemeral: true });
  } finally {
    if (oggPath && fs.existsSync(oggPath)) await fsp.unlink(oggPath);
    previewMap.delete(originalInteractionId);
  }
}