// src/commands/roman.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, AttachmentBuilder } from 'discord.js';
import path from 'path';

const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

export default {
  data: new SlashCommandBuilder()
    .setName('رمان')
    .setDescription('بفصصلك رمان'),

  async execute(interaction: ChatInputCommandInteraction) {
    const initialMessage = await interaction.reply({
      content: 'ثانية يمدام هروح اجيبه من التلاجة',
      fetchReply: true,
    });

    const image1 = path.join(__dirname, '../../bot/roman/talaga.jpg');
    const image2 = path.join(__dirname, '../../bot/roman/roman.jpg');

    const attachment1 = new AttachmentBuilder(image1);
    const attachment2 = new AttachmentBuilder(image2);

    await wait(5000);
    await initialMessage.edit({
      content: 'ثانية بس بفتح التلاجة',
      files: [attachment1],
    });

    await wait(5000);
    await initialMessage.edit({
      content: 'اتفضلي يمدام رمان بارد من التلاجة',
      files: [attachment2],
    });
  },
};
