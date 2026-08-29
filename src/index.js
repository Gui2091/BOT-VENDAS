require('dotenv').config();

const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const config = require('./config');
const { products, getProduct, formatBRL } = require('./products');
const { createPixCharge, getPixPaymentStatus, cancelPixCharge } = require('./payment');
const { allTickets, getTicket, saveTicket, removeTicket, findOpenTicketForUser, getPanel, savePanel } = require('./store');
const { publishTranscript } = require('./transcript');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  throw new Error('Preencha DISCORD_TOKEN e CLIENT_ID no arquivo .env antes de iniciar o bot.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const inactivityTimers = new Map();
const closingTimers = new Map();
const pixExpirationTimers = new Map();
const INACTIVITY_MS = 30 * 60 * 1000;
const SERVICE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RATING_CLOSE_MS = 5 * 60 * 1000;
const PIX_EXPIRATION_MS = 5 * 60 * 1000;
let checkingPixPayments = false;

const colors = { blue: 0x2563eb, orange: 0xf59e0b, green: 0x22c55e, red: 0xef4444, gray: 0x64748b };

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

function isSeller(member) {
  return isAdmin(member) || member.roles.cache.has(config.sellerRoleId);
}

function slug(value) {
  return value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 70) || 'cliente';
}

function ticketName(ticket, icon = '🛒') {
  return `${icon}-${slug(ticket.ownerName)}`.slice(0, 100);
}

function total(ticket) {
  return ticket.items.reduce((sum, item) => sum + item.price, 0);
}

function makeEmbed(title, description, color = colors.blue) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'Loja Oficial — REAL RP • Atendimento seguro pelo bot' });
}

function panelPayload() {
  const list = products.map((product) => `**${product.name}** — ${product.euro} | ${formatBRL(product.price)}\n${product.description}\nRenovação: ${product.renewal}`).join('\n\n');
  return {
    embeds: [makeEmbed('🛒 LOJA OFICIAL — REAL RP', `Confira os produtos disponíveis e inicie sua compra com segurança.\n\n${list}`, colors.blue)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('store:open').setLabel('Abrir compra').setEmoji('🛒').setStyle(ButtonStyle.Primary)
    )]
  };
}

function itemsText(ticket) {
  if (!ticket.items.length) return 'Nenhum item selecionado.';
  return ticket.items.map((item, index) => `\`${index + 1}.\` **${item.name}** — ${formatBRL(item.price)}`).join('\n');
}

function languageText(ticket) {
  return ticket.language === 'en' ? 'English' : 'Português';
}

function text(ticket, portuguese, english) {
  return ticket.language === 'en' ? english : portuguese;
}

function productSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('flow:product')
      .setPlaceholder('Escolha um item para adicionar ao carrinho')
      .addOptions(products.map((product) => ({
        label: product.name,
        value: product.id,
        description: `${product.name}: ${formatBRL(product.price).replace(/[R$\s.,]/g, '')} - ${product.renewal.toLowerCase()} a partir da compra`.slice(0, 100)
      })))
  );
}

function flowPayload(ticket) {
  const cart = `**Seu carrinho**\n${itemsText(ticket)}\n\n**Total:** ${formatBRL(ticket.total || total(ticket))}`;

  if (ticket.stage === 'language') {
    return {
      embeds: [makeEmbed('Olá! Eu sou o assistente virtual da Loja REAL RP', 'Vou guiar sua compra passo a passo. Escolha o idioma para continuar.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('flow:language:pt').setLabel('Português').setEmoji('🇧🇷').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('flow:language:en').setLabel('English').setEmoji('🇺🇸').setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  if (ticket.stage === 'shop') {
    return {
      embeds: [makeEmbed(text(ticket, 'Escolha seus produtos', 'Choose your products'), `${cart}\n\n${text(ticket, 'Use o menu abaixo para adicionar itens. Você pode selecionar quantos desejar.', 'Use the menu below to add items. You may select as many as you wish.')}`)],
      components: [productSelect(), new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('flow:checkout').setLabel(text(ticket, 'Ir para pagamento', 'Go to payment')).setEmoji('💳').setStyle(ButtonStyle.Success).setDisabled(!ticket.items.length)
      )]
    };
  }

  if (ticket.stage === 'payment_method') {
    return {
      embeds: [makeEmbed(text(ticket, 'Escolha a forma de pagamento', 'Choose a payment method'), `${cart}\n\n${text(ticket, 'Selecione **PIX** ou **PayPal** para continuar.', 'Select **PIX** or **PayPal** to continue.')}`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('flow:pix').setLabel(text(ticket, 'Gerar PIX', 'Generate PIX')).setEmoji('🔐').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('flow:paypal').setLabel('PayPal').setEmoji('🅿️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('flow:backShop').setLabel(text(ticket, 'Adicionar mais itens', 'Add more items')).setEmoji('🛒').setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  if (ticket.stage === 'pix_generated') {
    const pix = ticket.pix;
    const pixBody = pix
      ? text(ticket, `Copie o código PIX abaixo no aplicativo do seu banco:\n\n\`\`\`${pix.copyPaste}\`\`\`\n\nO QR Code foi enviado em uma mensagem separada abaixo. Assim que o pagamento for aprovado, o bot atualizará este ticket automaticamente.`, `Copy the PIX code below in your bank app:\n\n\`\`\`${pix.copyPaste}\`\`\`\n\nThe QR Code was sent in a separate message below. Once the payment is approved, the bot will update this ticket automatically.`)
      : text(ticket, 'A geração automática de PIX ainda não foi configurada. Um vendedor pode assumir este ticket para continuar o pagamento com segurança.', 'Automatic PIX generation has not been configured yet. A seller can take this ticket to safely continue payment.');
    return {
      embeds: [makeEmbed(text(ticket, 'PIX gerado', 'PIX generated'), `${cart}\n\n${pixBody}`, colors.blue)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('flow:backPayment').setLabel(text(ticket, 'Escolher outra forma', 'Choose another method')).setEmoji('↩️').setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  if (ticket.stage === 'pix_expired') {
    return {
      embeds: [makeEmbed(text(ticket, 'PIX expirado', 'PIX expired'), `${cart}\n\n${text(ticket, 'O prazo de 5 minutos para pagamento expirou. O código e o QR Code foram removidos. Este ticket será fechado em 5 minutos, a menos que você chame um vendedor.', 'The 5-minute payment window has expired. The code and QR Code were removed. This ticket will close in 5 minutes unless you call a seller.')}`, colors.orange)],
      components: []
    };
  }

  if (ticket.stage === 'paypal_generated') {
    const paymentUrl = process.env.PAYPAL_PAYMENT_URL;
    const paypalBody = paymentUrl
      ? text(ticket, 'Clique em **Pagar com PayPal** para abrir o pagamento seguro. Depois de concluir, informe o pagamento abaixo. A entrega será acompanhada por um vendedor.', 'Click **Pay with PayPal** to open the secure checkout. Once completed, report the payment below. A seller will follow the delivery.')
      : text(ticket, 'O link de pagamento do PayPal ainda não foi configurado. Solicite suporte para concluir o pedido.', 'The PayPal payment link has not been configured yet. Request support to complete the order.');
    const buttons = new ActionRowBuilder();
    if (paymentUrl) buttons.addComponents(new ButtonBuilder().setLabel(text(ticket, 'Pagar com PayPal', 'Pay with PayPal')).setEmoji('🅿️').setStyle(ButtonStyle.Link).setURL(paymentUrl));
    buttons.addComponents(
      new ButtonBuilder().setCustomId('flow:paid').setLabel(text(ticket, 'Já realizei o pagamento', 'I have made the payment')).setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!paymentUrl),
      new ButtonBuilder().setCustomId('flow:backPayment').setLabel(text(ticket, 'Escolher outra forma', 'Choose another method')).setEmoji('↩️').setStyle(ButtonStyle.Secondary)
    );
    return {
      embeds: [makeEmbed('PayPal', `${cart}\n\n${paypalBody}`, colors.blue)],
      components: [buttons]
    };
  }

  if (ticket.stage === 'awaiting_delivery') {
    return {
      embeds: [makeEmbed(text(ticket, 'Pagamento informado — aguardando vendedor', 'Payment reported — waiting for seller'), `${cart}\n\n${text(ticket, 'Seu pagamento foi informado. Um vendedor precisa acompanhar a entrega antes de finalizar a compra. Por segurança, este ticket não pode mais ser cancelado.', 'Your payment was reported. A seller must follow the delivery before completing the purchase. For security, this ticket can no longer be cancelled.')}`, colors.green)],
      components: []
    };
  }

  if (ticket.stage === 'support_waiting') {
    return {
      embeds: [makeEmbed(text(ticket, 'Suporte solicitado', 'Support requested'), `${text(ticket, 'Seu pedido está aguardando um vendedor. Enquanto ninguém assumir, você pode cancelar apenas esta solicitação de suporte.', 'Your request is waiting for a seller. Until someone takes it, you may cancel only this support request.')}\n\n${cart}`, colors.orange)],
      components: []
    };
  }

  if (ticket.stage === 'support_assigned' || ticket.stage === 'delivery_assigned') {
    const delivery = ticket.stage === 'delivery_assigned';
    return {
      embeds: [makeEmbed(delivery ? text(ticket, 'Vendedor acompanhando a entrega', 'Seller following delivery') : text(ticket, 'Atendimento assumido', 'Support taken'), `${text(ticket, delivery ? 'A entrega está sendo acompanhada' : 'O suporte assumiu sua solicitação', delivery ? 'Delivery is being followed' : 'Support has taken your request')} por <@${ticket.assignedTo}>. ${text(ticket, 'O atendente pode dar continuidade pelo bot ou finalizar o atendimento.', 'The agent can continue through the bot or finish the service.')}\n\n${cart}`, colors.green)],
      components: []
    };
  }

  return {
    embeds: [makeEmbed(text(ticket, 'Atendimento finalizado', 'Service completed'), `${text(ticket, 'Este atendimento foi finalizado', 'This service was completed')} por <@${ticket.assignedTo}>. ${text(ticket, 'Obrigado pela compra! Você pode avaliar o atendimento abaixo. Este ticket fechará automaticamente em 5 minutos.', 'Thank you for your purchase! You can rate the service below. This ticket will close automatically in 5 minutes.')}\n\n${cart}`, colors.green)],
    components: []
  };
}

function controlsPayload(ticket) {
  const locked = ['awaiting_delivery', 'delivery_assigned', 'completed'].includes(ticket.stage);
  const row = new ActionRowBuilder();

  if (ticket.stage === 'language') {
    return {
      embeds: [makeEmbed('Compra REAL RP', 'Primeiro, selecione o idioma no painel abaixo para iniciar o atendimento.', colors.gray)],
      components: []
    };
  }

  if (ticket.stage === 'support_waiting') {
    row.addComponents(
      new ButtonBuilder().setCustomId('control:claim').setLabel(text(ticket, 'Assumir ticket', 'Take ticket')).setEmoji('🟠').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('control:cancelSupport').setLabel(text(ticket, 'Cancelar suporte', 'Cancel support')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('control:cancel').setLabel(text(ticket, 'Cancelar compra', 'Cancel purchase')).setEmoji('✖️').setStyle(ButtonStyle.Danger)
    );
  } else if (ticket.stage === 'awaiting_delivery') {
    row.addComponents(new ButtonBuilder().setCustomId('control:claim').setLabel(text(ticket, 'Assumir entrega', 'Take delivery')).setEmoji('🟢').setStyle(ButtonStyle.Success));
  } else if (ticket.stage === 'pix_expired') {
    row.addComponents(new ButtonBuilder().setCustomId('control:callSeller').setLabel(text(ticket, 'Chamar vendedor', 'Call seller')).setEmoji('🆘').setStyle(ButtonStyle.Primary));
  } else if (ticket.stage === 'support_assigned' || ticket.stage === 'delivery_assigned') {
    row.addComponents(
      new ButtonBuilder().setCustomId('control:continue').setLabel(text(ticket, 'Dar continuidade', 'Continue')).setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('control:finalize').setLabel(text(ticket, 'Finalizar atendimento', 'Finish service')).setEmoji('✅').setStyle(ButtonStyle.Success)
    );
  } else if (ticket.stage === 'completed') {
    row.addComponents(
      new ButtonBuilder().setCustomId('rating:start:support').setLabel(text(ticket, 'Avaliar suporte', 'Rate support')).setEmoji('🛟').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('rating:start:purchase').setLabel(text(ticket, 'Avaliar compra', 'Rate purchase')).setEmoji('🛒').setStyle(ButtonStyle.Success)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId('control:reset').setLabel(text(ticket, 'Reiniciar carrinho', 'Restart cart')).setEmoji('🔄').setStyle(ButtonStyle.Secondary).setDisabled(locked),
      new ButtonBuilder().setCustomId('control:support').setLabel(text(ticket, 'Interferir com suporte', 'Request support')).setEmoji('🆘').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('control:cancel').setLabel(text(ticket, 'Cancelar compra', 'Cancel purchase')).setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(locked)
    );
    if (ticket.assignedTo) row.addComponents(new ButtonBuilder().setCustomId('control:finalize').setLabel(text(ticket, 'Finalizar atendimento', 'Finish service')).setEmoji('✅').setStyle(ButtonStyle.Success));
  }

  return { embeds: [makeEmbed(text(ticket, 'Central de atendimento', 'Service centre'), text(ticket, 'Use apenas os botões abaixo. O chat fica bloqueado até um atendente assumir o ticket.', 'Use only the buttons below. Chat remains locked until a staff member takes the ticket.'), colors.gray)], components: [row] };
}

async function logAction(guild, title, ticket, details = '') {
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = makeEmbed(title, `${details}\n\n**Cliente:** <@${ticket.ownerId}>\n**Canal:** <#${ticket.channelId}>\n**Etapa:** ${ticket.stage}`, colors.gray).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => null);
}

function clearTicketTimers(channelId) {
  clearTimeout(inactivityTimers.get(channelId));
  clearTimeout(closingTimers.get(channelId));
  inactivityTimers.delete(channelId);
  closingTimers.delete(channelId);
  clearTimeout(pixExpirationTimers.get(channelId));
  pixExpirationTimers.delete(channelId);
}

function schedulePixExpiration(ticket) {
  clearTimeout(pixExpirationTimers.get(ticket.channelId));
  if (ticket.stage !== 'pix_generated' || !ticket.pix?.expiresAt) return;
  const delay = Math.max(1_000, new Date(ticket.pix.expiresAt).getTime() - Date.now());
  pixExpirationTimers.set(ticket.channelId, setTimeout(() => expirePix(ticket.channelId), delay));
}

async function expirePix(channelId) {
  const ticket = getTicket(channelId);
  if (!ticket || ticket.stage !== 'pix_generated') return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  try { await cancelPixCharge(ticket.pix?.id); } catch (error) { console.error(error); }
  if (ticket.pixQrMessageId) {
    const qrMessage = await channel.messages.fetch(ticket.pixQrMessageId).catch(() => null);
    await qrMessage?.delete().catch(() => null);
  }
  delete ticket.pixQrMessageId;
  delete ticket.pix.copyPaste;
  delete ticket.pix.qrCodeBase64;
  ticket.stage = 'pix_expired';
  await setChannelStatus(channel, ticket, '🟠');
  await updateTicketView(channel, ticket);
  scheduleClosing(ticket, RATING_CLOSE_MS, 'pix expirado');
  await channel.send({ content: `<@${ticket.ownerId}> o prazo para pagar o PIX terminou. Este ticket será fechado em 5 minutos, ou você pode chamar um vendedor pelo botão acima.`, allowedMentions: { users: [ticket.ownerId] } });
  await logAction(channel.guild, 'PIX expirado', ticket, 'Cobrança cancelada por falta de pagamento após 5 minutos.');
}

function touchTicket(ticket) {
  ticket.lastActivityAt = new Date().toISOString();
  saveTicket(ticket);
  scheduleInactivity(ticket);
}

function scheduleInactivity(ticket) {
  clearTimeout(inactivityTimers.get(ticket.channelId));
  if (ticket.stage === 'completed') return;
  const elapsed = Date.now() - new Date(ticket.lastActivityAt || ticket.createdAt).getTime();
  const delay = Math.max(1_000, INACTIVITY_MS - elapsed);
  inactivityTimers.set(ticket.channelId, setTimeout(() => closeTicketAutomatically(ticket.channelId, 'inatividade'), delay));
}

function scheduleClosing(ticket, delayMs, reason) {
  clearTimeout(closingTimers.get(ticket.channelId));
  ticket.closesAt = new Date(Date.now() + delayMs).toISOString();
  saveTicket(ticket);
  closingTimers.set(ticket.channelId, setTimeout(() => closeTicketAutomatically(ticket.channelId, reason), delayMs));
}

function scheduledCloseReason(ticket) {
  if (ticket.stage === 'completed') return 'compra concluída';
  if (ticket.stage === 'pix_expired') return 'pix expirado';
  return 'tempo de atendimento';
}

async function syncPixQrCode(channel, ticket) {
  if (!ticket.pix?.qrCodeBase64 || ticket.pixQrMessageId) return;
  const file = new AttachmentBuilder(Buffer.from(ticket.pix.qrCodeBase64, 'base64'), { name: `pix-${ticket.channelId}.png` });
  const message = await channel.send({ content: '📷 **QR Code PIX**', files: [file] });
  ticket.pixQrMessageId = message.id;
  saveTicket(ticket);
}

async function archiveTicketTranscript(channel, ticket, reason) {
  try {
    const result = await publishTranscript(channel, ticket, reason);
    if (!result) return null;
    ticket.transcriptUrl = result.url;
    await channel.send({
      embeds: [makeEmbed('Resumo do ticket', `**Cliente:** ${result.summary.owner}\n**Atendente:** ${result.summary.attendant || '—'}\n**Pagamento:** ${result.summary.paymentMethod}\n**Valor:** ${result.summary.amount}\n**Pagamento aprovado em:** ${result.summary.paymentDate || '—'}`, colors.gray)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Abrir transcript completo').setEmoji('📄').setStyle(ButtonStyle.Link).setURL(result.url))]
    });
    return result.url;
  } catch (error) {
    console.error(`Falha ao gerar transcript do ticket ${ticket.channelId}:`, error.message);
    return null;
  }
}

async function sendClosingDm(ticket, reason) {
  const user = await client.users.fetch(ticket.ownerId).catch(() => null);
  if (!user) return;
  const message = reason === 'compra concluída'
    ? 'Obrigado pela sua compra na Loja REAL RP! Seu atendimento foi concluído e o ticket foi fechado.'
    : reason === 'pix expirado'
      ? 'Seu ticket da Loja REAL RP foi fechado porque o prazo de 5 minutos para o pagamento PIX expirou.'
    : reason === 'tempo de atendimento'
      ? 'Seu ticket da Loja REAL RP foi fechado após 2 horas de atendimento. Quando precisar, você pode abrir uma nova compra.'
    : 'Seu ticket da Loja REAL RP foi fechado por inatividade de 30 minutos. Quando precisar, você pode abrir uma nova compra.';
  await user.send({ embeds: [makeEmbed('Atualização do seu ticket', message, reason === 'compra concluída' ? colors.green : colors.orange)] }).catch(() => null);
}

async function closeTicketAutomatically(channelId, reason) {
  const ticket = getTicket(channelId);
  if (!ticket) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  clearTicketTimers(channelId);
  removeTicket(channelId);
  if (channel?.isTextBased()) {
    const description = reason === 'compra concluída'
      ? `<@${ticket.ownerId}> obrigado pela compra! Este ticket será fechado em alguns segundos.`
      : reason === 'pix expirado'
        ? `<@${ticket.ownerId}> este ticket foi encerrado porque o prazo de pagamento PIX expirou.`
      : reason === 'tempo de atendimento'
        ? `<@${ticket.ownerId}> este ticket foi encerrado após **2 horas de atendimento**.`
      : `<@${ticket.ownerId}> este ticket foi encerrado por **30 minutos de inatividade**.`;
    await channel.send({ embeds: [makeEmbed('Ticket encerrado', description, reason === 'compra concluída' ? colors.green : colors.orange)] }).catch(() => null);
    await archiveTicketTranscript(channel, ticket, reason);
  }
  await sendClosingDm(ticket, reason);
  if (channel?.deletable) setTimeout(() => channel.delete(`Encerramento automático: ${reason}`).catch(() => null), 5_000);
}

async function checkPixPayments() {
  if (checkingPixPayments) return;
  checkingPixPayments = true;
  try {
    const pendingTickets = Object.values(allTickets()).filter((ticket) => ticket.stage === 'pix_generated' && ticket.pix?.id);
    for (const ticket of pendingTickets) {
      let status;
      try {
        status = await getPixPaymentStatus(ticket.pix.id);
      } catch (error) {
        console.error(`Falha ao consultar PIX ${ticket.pix.id}:`, error.message);
        continue;
      }
      if (status !== 'approved') continue;
      const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;
      clearTimeout(pixExpirationTimers.get(ticket.channelId));
      pixExpirationTimers.delete(ticket.channelId);
      ticket.stage = 'awaiting_delivery';
      ticket.pix.approvedAt = new Date().toISOString();
      ticket.paymentMethod = 'pix';
      ticket.paymentApprovedAt = ticket.pix.approvedAt;
      await setChannelStatus(channel, ticket, '🟠');
      await updateTicketView(channel, ticket);
      await channel.send({
        content: `<@${ticket.ownerId}> ✅ PIX aprovado automaticamente. <@&${config.sellerRoleId}> um vendedor pode assumir a entrega.`,
        allowedMentions: { users: [ticket.ownerId], roles: [config.sellerRoleId] }
      });
      await logAction(channel.guild, 'PIX aprovado automaticamente', ticket, `**Valor:** ${formatBRL(ticket.total)}`);
    }
  } finally {
    checkingPixPayments = false;
  }
}

async function updateTicketView(channel, ticket) {
  ticket.total = total(ticket);
  touchTicket(ticket);
  const workflow = await channel.messages.fetch(ticket.workflowMessageId).catch(() => null);
  const controls = await channel.messages.fetch(ticket.controlsMessageId).catch(() => null);
  if (workflow) await workflow.edit(flowPayload(ticket));
  if (controls) await controls.edit(controlsPayload(ticket));
  await syncPixQrCode(channel, ticket);
}

async function setChannelStatus(channel, ticket, icon) {
  await channel.setName(ticketName(ticket, icon)).catch(() => null);
}

async function replyPrivate(interaction, title, text, color = colors.red) {
  const payload = { embeds: [makeEmbed(title, text, color)], flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function publishPanel(guild) {
  const channel = await guild.channels.fetch(config.storeChannelId);
  if (!channel?.isTextBased()) throw new Error('O canal da loja não foi encontrado ou não aceita mensagens.');
  const saved = getPanel();
  const old = saved && await channel.messages.fetch(saved.messageId).catch(() => null);
  const message = old ? await old.edit(panelPayload()) : await channel.send(panelPayload());
  savePanel({ messageId: message.id, channelId: channel.id });
  return message;
}

async function createTicket(interaction) {
  const existing = findOpenTicketForUser(interaction.user.id);
  if (existing) {
    const exists = await interaction.guild.channels.fetch(existing.channelId).catch(() => null);
    if (exists) return replyPrivate(interaction, 'Você já possui uma compra aberta', `Continue pelo canal <#${existing.channelId}>.`, colors.orange);
    removeTicket(existing.channelId);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ticket = {
    ownerId: interaction.user.id,
    ownerName: interaction.user.username,
    items: [], total: 0, language: 'pt', stage: 'language', assignedTo: null,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  };
  const channel = await interaction.guild.channels.create({
    name: ticketName(ticket),
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId,
    topic: `Compra REAL RP • Cliente: ${interaction.user.id}`,
    permissionOverwrites: [
      { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      { id: config.sellerRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] }
    ]
  });
  await channel.send({
    content: `<@${ticket.ownerId}> <@&${config.sellerRoleId}> novo ticket de compra aberto.`,
    allowedMentions: { users: [ticket.ownerId], roles: [config.sellerRoleId] }
  });
  const controls = await channel.send(controlsPayload(ticket));
  const workflow = await channel.send(flowPayload(ticket));
  ticket.channelId = channel.id;
  ticket.workflowMessageId = workflow.id;
  ticket.controlsMessageId = controls.id;
  saveTicket(ticket);
  scheduleInactivity(ticket);
  await logAction(interaction.guild, 'Novo ticket de compra', ticket, 'Ticket criado pelo painel da loja.');
  await interaction.editReply({ embeds: [makeEmbed('Compra iniciada', `Seu atendimento foi aberto em <#${channel.id}>.`, colors.green)] });
}

async function ownerTicket(interaction) {
  const ticket = getTicket(interaction.channelId);
  if (!ticket) return null;
  if (ticket.ownerId !== interaction.user.id) {
    await replyPrivate(interaction, 'Ação não permitida', 'Somente o cliente que abriu este ticket pode usar este botão.');
    return null;
  }
  return ticket;
}

async function sellerTicket(interaction) {
  const ticket = getTicket(interaction.channelId);
  if (!ticket) return null;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isSeller(member)) {
    await replyPrivate(interaction, 'Ação restrita', 'Apenas vendedores e administradores podem assumir ou finalizar tickets.');
    return null;
  }
  return ticket;
}

async function deleteTicket(interaction, ticket, reason) {
  if (ticket.stage === 'pix_generated' && ticket.pix?.id) {
    await cancelPixCharge(ticket.pix.id).catch((error) => console.error(error));
  }
  clearTicketTimers(ticket.channelId);
  await logAction(interaction.guild, 'Ticket encerrado', ticket, `**Motivo:** ${reason}\n**Responsável:** <@${interaction.user.id}>`);
  await archiveTicketTranscript(interaction.channel, ticket, reason);
  removeTicket(ticket.channelId);
  await interaction.reply({ embeds: [makeEmbed('Ticket encerrado', 'O ticket será removido em alguns segundos.', colors.red)] });
  setTimeout(() => interaction.channel.delete(reason).catch(() => null), 2500);
}

client.once(Events.ClientReady, async (readyClient) => {
  readyClient.user.setPresence({
    status: 'online',
    activities: [{ name: 'Loja REAL RP', type: ActivityType.Watching }]
  });
  console.log(`Conectado como ${readyClient.user.tag}`);
  const guild = process.env.GUILD_ID ? await readyClient.guilds.fetch(process.env.GUILD_ID).catch(() => null) : null;
  if (!guild) return console.warn('Defina GUILD_ID no .env para publicar o painel e registrar /loja.');
  await guild.commands.set([{ name: 'loja', description: 'Publica ou atualiza o painel da loja' }]);
  await publishPanel(guild).catch((error) => console.error(`Não foi possível publicar o painel: ${error.message}`));
  setInterval(checkPixPayments, 15_000);
  checkPixPayments();
  for (const ticket of Object.values(allTickets())) {
    if (ticket.closesAt) {
      const remaining = new Date(ticket.closesAt).getTime() - Date.now();
      if (remaining <= 0) closeTicketAutomatically(ticket.channelId, scheduledCloseReason(ticket));
      else closingTimers.set(ticket.channelId, setTimeout(() => closeTicketAutomatically(ticket.channelId, scheduledCloseReason(ticket)), remaining));
    }
    schedulePixExpiration(ticket);
    scheduleInactivity(ticket);
  }
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot || !message.guildId) return;
  const ticket = getTicket(message.channelId);
  if (!ticket) return;
  if (message.author.id === ticket.ownerId || message.author.id === ticket.assignedTo) touchTicket(ticket);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'loja') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isAdmin(member)) return replyPrivate(interaction, 'Ação restrita', 'Apenas administradores podem publicar o painel.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await publishPanel(interaction.guild);
      return interaction.editReply({ embeds: [makeEmbed('Painel atualizado', `O painel da loja está em <#${message.channelId}>.`, colors.green)] });
    }

    if (interaction.isButton() && interaction.customId === 'store:open') return createTicket(interaction);

    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    if (interaction.isStringSelectMenu() && interaction.customId === 'flow:product') {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      const product = getProduct(interaction.values[0]);
      if (!product || ticket.stage !== 'shop') return replyPrivate(interaction, 'Seleção indisponível', 'Volte ao carrinho para selecionar um produto.');
      ticket.items.push({ id: product.id, name: product.name, price: product.price });
      ticket.total = total(ticket);
      await interaction.deferUpdate();
      await updateTicketView(interaction.channel, ticket);
      await logAction(interaction.guild, 'Produto adicionado', ticket, `**Produto:** ${product.name}`);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('flow:')) {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      const id = interaction.customId;
      if (id.startsWith('flow:language:') && ticket.stage === 'language') {
        ticket.language = id.endsWith(':en') ? 'en' : 'pt'; ticket.stage = 'shop';
      } else if (id === 'flow:checkout' && ticket.stage === 'shop' && ticket.items.length) {
        ticket.stage = 'payment_method';
      } else if (id === 'flow:backShop' && ticket.stage === 'payment_method') {
        ticket.stage = 'shop';
      } else if (id === 'flow:backPayment' && ['pix_generated', 'paypal_generated'].includes(ticket.stage)) {
        await interaction.deferUpdate();
        if (ticket.stage === 'pix_generated' && ticket.pix?.id) {
          await cancelPixCharge(ticket.pix.id).catch((error) => console.error(error));
          clearTimeout(pixExpirationTimers.get(ticket.channelId));
          pixExpirationTimers.delete(ticket.channelId);
          if (ticket.pixQrMessageId) {
            const qrMessage = await interaction.channel.messages.fetch(ticket.pixQrMessageId).catch(() => null);
            await qrMessage?.delete().catch(() => null);
          }
          delete ticket.pix;
          delete ticket.pixQrMessageId;
        }
        ticket.stage = 'payment_method';
        await updateTicketView(interaction.channel, ticket);
        await logAction(interaction.guild, 'Forma de pagamento alterada', ticket, `**Cliente:** <@${ticket.ownerId}>`);
        return;
      } else if (id === 'flow:pix' && ticket.stage === 'payment_method') {
        await interaction.deferUpdate();
        try {
          ticket.pix = await createPixCharge(ticket, interaction.user);
          ticket.pix.expiresAt = new Date(Date.now() + PIX_EXPIRATION_MS).toISOString();
          ticket.paymentMethod = 'pix';
          ticket.stage = 'pix_generated';
          await updateTicketView(interaction.channel, ticket);
          schedulePixExpiration(ticket);
          await logAction(interaction.guild, 'PIX gerado', ticket, `**Valor:** ${formatBRL(ticket.total)}`);
        } catch (error) {
          const message = error.message.includes('(401)')
            ? 'O Mercado Pago recusou a credencial de produção. Gere ou copie novamente o Access Token da aplicação correta, ative as credenciais de produção e reinicie o bot.'
            : 'Tente novamente em instantes ou solicite suporte.';
          await replyPrivate(interaction, 'Não foi possível gerar o PIX', message);
          console.error(error);
        }
        return;
      } else if (id === 'flow:paypal' && ticket.stage === 'payment_method') {
        ticket.paymentMethod = 'paypal';
        ticket.stage = 'paypal_generated';
      } else if (id === 'flow:paid' && ticket.stage === 'paypal_generated' && process.env.PAYPAL_PAYMENT_URL) {
        ticket.stage = 'awaiting_delivery';
        ticket.paymentApprovedAt = new Date().toISOString();
        await interaction.deferUpdate();
        await setChannelStatus(interaction.channel, ticket, '🟠');
        await updateTicketView(interaction.channel, ticket);
        await interaction.channel.send({ content: `<@&${config.sellerRoleId}> pagamento informado por <@${ticket.ownerId}>. Um vendedor pode assumir o ticket.`, allowedMentions: { users: [ticket.ownerId], roles: [config.sellerRoleId] } });
        await logAction(interaction.guild, 'Pagamento informado pelo cliente', ticket, `**Valor:** ${formatBRL(ticket.total)}`);
        return;
      } else {
        return replyPrivate(interaction, 'Ação indisponível', 'Este passo já foi concluído ou não está disponível agora.');
      }
      await interaction.deferUpdate();
      await updateTicketView(interaction.channel, ticket);
      await logAction(interaction.guild, 'Etapa de compra atualizada', ticket, `**Idioma:** ${languageText(ticket)}`);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:support') {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (!['shop', 'payment_method', 'pix_generated', 'paypal_generated'].includes(ticket.stage)) return replyPrivate(interaction, 'Suporte indisponível', 'Escolha o idioma e avance no atendimento antes de solicitar suporte.');
      ticket.resumeStage = ticket.stage; ticket.stage = 'support_waiting';
      await interaction.deferUpdate();
      await setChannelStatus(interaction.channel, ticket, '🟠');
      await updateTicketView(interaction.channel, ticket);
      await logAction(interaction.guild, 'Suporte solicitado', ticket, 'Aguardando vendedor ou administrador assumir.');
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:cancelSupport') {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (ticket.stage !== 'support_waiting') return replyPrivate(interaction, 'Ação indisponível', 'O suporte já foi assumido ou não está pendente.');
      ticket.stage = ticket.resumeStage || 'shop'; delete ticket.resumeStage;
      await interaction.deferUpdate();
      await setChannelStatus(interaction.channel, ticket, '🛒');
      await updateTicketView(interaction.channel, ticket);
      await logAction(interaction.guild, 'Solicitação de suporte cancelada', ticket, 'Cliente voltou ao atendimento automático.');
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:cancel') {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (ticket.stage === 'language') return replyPrivate(interaction, 'Escolha o idioma primeiro', 'Selecione Português ou English antes de cancelar a compra.');
      if (['awaiting_delivery', 'delivery_assigned', 'completed'].includes(ticket.stage)) return replyPrivate(interaction, 'Compra protegida', 'Após informar o pagamento, o ticket só pode ser finalizado por um vendedor.');
      return deleteTicket(interaction, ticket, 'Compra cancelada pelo cliente');
    }

    if (interaction.isButton() && interaction.customId === 'control:callSeller') {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (ticket.stage !== 'pix_expired') return replyPrivate(interaction, 'Ação indisponível', 'Este botão só está disponível após o prazo do PIX expirar.');
      clearTimeout(closingTimers.get(ticket.channelId));
      ticket.resumeStage = 'shop';
      ticket.stage = 'support_waiting';
      await interaction.deferUpdate();
      await updateTicketView(interaction.channel, ticket);
      await interaction.channel.send({ content: `<@&${config.sellerRoleId}> <@${ticket.ownerId}> chamou um vendedor após o PIX expirar.`, allowedMentions: { users: [ticket.ownerId], roles: [config.sellerRoleId] } });
      await logAction(interaction.guild, 'Vendedor chamado após PIX expirado', ticket);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:reset') {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (!['shop', 'payment_method', 'pix_generated', 'paypal_generated'].includes(ticket.stage)) return replyPrivate(interaction, 'Ação indisponível', 'O carrinho não pode mais ser reiniciado nesta etapa.');
      ticket.items = [];
      ticket.total = 0;
      delete ticket.pix;
      ticket.stage = 'shop';
      await interaction.deferUpdate();
      await setChannelStatus(interaction.channel, ticket, '🛒');
      await updateTicketView(interaction.channel, ticket);
      await logAction(interaction.guild, 'Carrinho reiniciado', ticket, 'O cliente removeu todos os itens do carrinho.');
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:claim') {
      const ticket = await sellerTicket(interaction); if (!ticket) return;
      if (!['support_waiting', 'awaiting_delivery'].includes(ticket.stage)) return replyPrivate(interaction, 'Ticket indisponível', 'Este ticket já foi assumido ou mudou de etapa.');
      const delivery = ticket.stage === 'awaiting_delivery';
      ticket.assignedTo = interaction.user.id;
      ticket.stage = delivery ? 'delivery_assigned' : 'support_assigned';
      await interaction.channel.permissionOverwrites.edit(ticket.ownerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await interaction.deferUpdate();
      await setChannelStatus(interaction.channel, ticket, '🟢');
      await updateTicketView(interaction.channel, ticket);
      scheduleClosing(ticket, SERVICE_TIMEOUT_MS, 'tempo de atendimento');
      await interaction.channel.send({ content: `<@${ticket.ownerId}> atendimento assumido por <@${interaction.user.id}>. O ticket será encerrado automaticamente em até 2 horas.`, allowedMentions: { users: [ticket.ownerId] } });
      await logAction(interaction.guild, delivery ? 'Entrega assumida' : 'Suporte assumido', ticket, `**Atendente:** <@${interaction.user.id}>`);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:continue') {
      const ticket = await sellerTicket(interaction); if (!ticket) return;
      if (!['support_assigned', 'delivery_assigned'].includes(ticket.stage) || ticket.assignedTo !== interaction.user.id) return replyPrivate(interaction, 'Ação indisponível', 'Somente o atendente que assumiu este ticket pode dar continuidade.');
      ticket.stage = ticket.resumeStage || 'shop';
      delete ticket.resumeStage;
      await interaction.deferUpdate();
      await updateTicketView(interaction.channel, ticket);
      await interaction.channel.send({ content: `<@${ticket.ownerId}> o atendimento retomou o menu automático.`, allowedMentions: { users: [ticket.ownerId] } });
      await logAction(interaction.guild, 'Atendimento retomado pelo bot', ticket, `**Atendente:** <@${interaction.user.id}>`);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'control:finalize') {
      const ticket = await sellerTicket(interaction); if (!ticket) return;
      if (!ticket.assignedTo || ticket.assignedTo !== interaction.user.id || ticket.stage === 'completed') return replyPrivate(interaction, 'Ação indisponível', 'Somente o atendente que assumiu este ticket pode finalizá-lo.');
      ticket.stage = 'completed';
      await interaction.deferUpdate();
      await updateTicketView(interaction.channel, ticket);
      scheduleClosing(ticket, RATING_CLOSE_MS, 'compra concluída');
      await interaction.channel.send({ content: `<@${ticket.ownerId}> seu atendimento foi finalizado. Avalie-o abaixo; o ticket fechará automaticamente em 5 minutos.`, allowedMentions: { users: [ticket.ownerId] } });
      await logAction(interaction.guild, 'Atendimento finalizado', ticket, `**Atendente:** <@${interaction.user.id}>`);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('rating:start:')) {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (ticket.stage !== 'completed') return replyPrivate(interaction, 'Avaliação indisponível', 'A avaliação fica disponível após a finalização do atendimento.');
      const type = interaction.customId.split(':')[2];
      if (!['support', 'purchase'].includes(type)) return;
      if (ticket.ratings?.[type]) return replyPrivate(interaction, 'Avaliação já enviada', 'Você já enviou sua avaliação para esta categoria.');
      const label = type === 'support' ? text(ticket, 'suporte', 'support') : text(ticket, 'compra', 'purchase');
      return interaction.reply({
        embeds: [makeEmbed(text(ticket, `Avaliar ${label}`, `Rate ${label}`), text(ticket, 'Escolha uma nota de 1 a 5 estrelas. Depois você poderá adicionar um comentário opcional.', 'Choose a rating from 1 to 5 stars. You can then add an optional comment.'), colors.blue)],
        components: [new ActionRowBuilder().addComponents(
          ...[1, 2, 3, 4, 5].map((stars) => new ButtonBuilder().setCustomId(`rating:stars:${type}:${stars}`).setLabel('⭐'.repeat(stars)).setStyle(ButtonStyle.Primary))
        )],
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith('rating:stars:')) {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (ticket.stage !== 'completed') return replyPrivate(interaction, 'Avaliação indisponível', 'Este atendimento já foi encerrado.');
      const [, , type, rawStars] = interaction.customId.split(':');
      const stars = Number(rawStars);
      if (!['support', 'purchase'].includes(type) || !Number.isInteger(stars) || stars < 1 || stars > 5) return;
      if (ticket.ratings?.[type]) return replyPrivate(interaction, 'Avaliação já enviada', 'Você já enviou sua avaliação para esta categoria.');
      const modal = new ModalBuilder().setCustomId(`rating:modal:${type}:${stars}`).setTitle('Comentário opcional');
      const comment = new TextInputBuilder().setCustomId('comment').setLabel('Conte como foi seu atendimento (opcional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(comment));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('rating:modal:')) {
      const ticket = await ownerTicket(interaction); if (!ticket) return;
      if (ticket.stage !== 'completed') return replyPrivate(interaction, 'Avaliação indisponível', 'Este atendimento já foi encerrado.');
      const [, , type, rawStars] = interaction.customId.split(':');
      const stars = Number(rawStars);
      if (!['support', 'purchase'].includes(type) || !Number.isInteger(stars) || stars < 1 || stars > 5) return;
      if (ticket.ratings?.[type]) return replyPrivate(interaction, 'Avaliação já enviada', 'Você já enviou sua avaliação para esta categoria.');
      const comment = interaction.fields.getTextInputValue('comment').trim();
      const ratingChannel = await interaction.guild.channels.fetch(config.ratingChannelId).catch(() => null);
      const typeLabel = type === 'support' ? 'Suporte' : 'Compra';
      if (ratingChannel?.isTextBased()) {
        await ratingChannel.send({ embeds: [makeEmbed(`⭐ Nova avaliação: ${typeLabel}`, `**Cliente:** <@${ticket.ownerId}>\n**Atendente:** <@${ticket.assignedTo}>\n**Nota:** ${'⭐'.repeat(stars)}\n${comment ? `**Comentário:** ${comment}` : '*Sem comentário.*'}`, colors.green)] });
      }
      ticket.ratings = { ...(ticket.ratings || {}), [type]: { stars, comment, createdAt: new Date().toISOString() } };
      await interaction.reply({ embeds: [makeEmbed('Avaliação enviada', 'Obrigado! Sua avaliação foi publicada.', colors.green)], flags: MessageFlags.Ephemeral });
      await updateTicketView(interaction.channel, ticket);
      await logAction(interaction.guild, `Avaliação de ${typeLabel.toLowerCase()} recebida`, ticket, `**Nota:** ${'⭐'.repeat(stars)}`);
      return;
    }
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await replyPrivate(interaction, 'Ocorreu um erro', 'Não foi possível concluir esta ação. Tente novamente em instantes.').catch(() => null);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
