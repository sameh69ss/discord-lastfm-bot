// src/sendVoice.ts
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { getAudioDurationInSeconds } from "get-audio-duration";

export default async function sendVoice(channelId: string, file: string, replyToMessageId?: string) {
  
  const TOKEN = process.env.DISCORD_TOKEN!;
  if (!TOKEN) {
    console.error("DISCORD_TOKEN is not set in sendVoice.ts");
    return;
  }

  const duration = Number(await getAudioDurationInSeconds(file));
  const fileStats = await fs.stat(file);
  const fileName = path.basename(file);

  
  const attachmentRequest = {
    files: [
      {
        filename: fileName,
        file_size: fileStats.size,
        id: "0",
      },
    ],
  };

  console.log("Step 1: Requesting upload URL...");
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/attachments`,
      {
        method: "POST",
        body: JSON.stringify(attachmentRequest),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${TOKEN}`,
        },
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to get upload URL: ${res.status} ${error}`);
    }

    const data = await res.json();
    console.log("Upload URL received:", data);

    
    console.log("Step 2: Uploading file...");
    const res2 = await fetch((data as any).attachments[0].upload_url, {
      method: "PUT",
      body: await fs.readFile(file),
      headers: {
        "Content-Type": "audio/ogg", // This is why we must convert to OGG
      },
    });

    if (!res2.ok) {
      throw new Error(`Failed to upload file: ${res2.status}`);
    }

    console.log("File uploaded successfully");

    
    const bodyPayload: any = {
      attachments: [
        {
          id: "0",
          filename: fileName,
          uploaded_filename: (data as any).attachments[0].upload_filename,
          duration_secs: duration,
          waveform: "AAAAAAAAAAAAAAAAAAAAAAAA", // B64-encoded 100-byte opus waveform
        },
      ],
      flags: 8192, // Is a voice message
    };

    if (replyToMessageId) {
      bodyPayload.message_reference = {
        message_id: replyToMessageId
      };
    }

    console.log("Step 3: Sending message...");
    const res3 = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify(bodyPayload),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${TOKEN}`,
        },
      }
    );

    if (!res3.ok) {
      const error = await res3.text();
      throw new Error(`Failed to send message: ${res3.status} ${error}`);
    }

    const data3 = await res3.json();
    console.log("Voice message sent successfully:");
    return data3;
  } catch (e) {
    console.error(e);
  }
}