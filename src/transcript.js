function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Santiago'
  }).format(new Date(value));
}

function messageBody(message) {
  const parts = [];
  if (message.content) parts.push(escapeHtml(message.content));
  for (const embed of message.embeds) {
    const text = [embed.title, embed.description, ...(embed.fields || []).flatMap((field) => [field.name, field.value])]
      .filter(Boolean).join('\n');
    if (text) parts.push(`<div class="embed">${escapeHtml(text)}</div>`);
  }
  for (const attachment of message.attachments.values()) {
    parts.push(`<a class="attachment" href="${escapeHtml(attachment.url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(attachment.name || 'Anexo')}</a>`);
  }
  return parts.length ? parts.join('<br>') : '<span class="empty">Mensagem sem texto</span>';
}

function buildTranscript(ticket, messages, reason) {
  const entries = messages.map((message) => {
    const avatar = message.author.displayAvatarURL({ extension: 'png', size: 64 });
    return `<article class="message">
      <img class="avatar" src="${escapeHtml(avatar)}" alt="">
      <div class="message-content">
        <div class="meta"><strong>${escapeHtml(message.author.username)}</strong>${message.author.bot ? '<span class="bot">BOT</span>' : ''}<time>${formatDate(message.createdAt)}</time></div>
        <div class="body">${messageBody(message)}</div>
      </div>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Transcript • ${escapeHtml(ticket.ownerName)}</title>
  <style>
    :root { color-scheme: dark; --bg:#111827; --card:#1f2937; --muted:#9ca3af; --line:#374151; --accent:#60a5fa; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:#f9fafb; font:15px/1.5 Inter,Segoe UI,Arial,sans-serif; }
    header { padding:28px max(20px,calc((100vw - 900px)/2)); border-bottom:1px solid var(--line); background:#0f172a; }
    h1 { margin:0 0 6px; font-size:22px; } .summary { margin:0; color:var(--muted); }
    main { width:min(900px,100%); margin:auto; padding:20px; } .message { display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--line); }
    .avatar { width:40px; height:40px; border-radius:50%; object-fit:cover; } .message-content { min-width:0; flex:1; }
    .meta { display:flex; align-items:center; gap:8px; } time { color:var(--muted); font-size:12px; } .bot { color:#bfdbfe; background:#1d4ed8; border-radius:4px; padding:1px 5px; font-size:10px; font-weight:700; }
    .body { margin-top:3px; white-space:pre-wrap; overflow-wrap:anywhere; } .embed { margin-top:8px; padding:10px 12px; border-left:4px solid var(--accent); background:var(--card); border-radius:4px; white-space:pre-wrap; }
    .attachment { display:block; color:#93c5fd; margin-top:8px; } .empty { color:var(--muted); font-style:italic; }
  </style>
</head>
<body>
  <header><h1>Transcript do ticket • ${escapeHtml(ticket.ownerName)}</h1><p class="summary">Cliente: ${escapeHtml(ticket.ownerName)} • Encerrado em ${formatDate(new Date())} • Motivo: ${escapeHtml(reason)}</p></header>
  <main>${entries || '<p>Nenhuma mensagem encontrada.</p>'}</main>
</body>
</html>`;
}

async function fetchTranscriptMessages(channel) {
  const messages = [];
  let before;
  do {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  } while (before);
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function publishTranscript(channel, ticket, reason) {
  const token = process.env.GITHUB_TRANSCRIPT_TOKEN?.trim();
  if (!token) return null;
  const repository = process.env.GITHUB_TRANSCRIPT_REPOSITORY || 'Gui2091/BOT-VENDAS';
  const branch = process.env.GITHUB_TRANSCRIPT_BRANCH || 'main';
  const baseUrl = (process.env.TRANSCRIPT_BASE_URL || 'https://bot-vendas.vercel.app').replace(/\/$/, '');
  const messages = await fetchTranscriptMessages(channel);
  const html = buildTranscript(ticket, messages, reason);
  const path = `public/transcripts/${ticket.channelId}.html`;
  const response = await fetch(`https://api.github.com/repos/${repository}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'BOT-VENDAS-transcripts',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Add transcript for ticket ${ticket.channelId}`,
      content: Buffer.from(html).toString('base64'),
      branch
    })
  });
  if (!response.ok) throw new Error(`Falha ao publicar transcript no GitHub (${response.status}): ${(await response.text()).slice(0, 180)}`);
  return `${baseUrl}/transcripts/${ticket.channelId}.html`;
}

module.exports = { publishTranscript };
