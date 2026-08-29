const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const ticketsPath = path.join(dataDir, 'tickets.json');
const panelPath = path.join(dataDir, 'panel.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function allTickets() {
  return readJson(ticketsPath, {});
}

function getTicket(channelId) {
  return allTickets()[channelId] || null;
}

function saveTicket(ticket) {
  const tickets = allTickets();
  tickets[ticket.channelId] = ticket;
  writeJson(ticketsPath, tickets);
  return ticket;
}

function removeTicket(channelId) {
  const tickets = allTickets();
  delete tickets[channelId];
  writeJson(ticketsPath, tickets);
}

function findOpenTicketForUser(userId) {
  return Object.values(allTickets()).find((ticket) => ticket.ownerId === userId) || null;
}

function getPanel() {
  return readJson(panelPath, null);
}

function savePanel(panel) {
  writeJson(panelPath, panel);
}

module.exports = { allTickets, getTicket, saveTicket, removeTicket, findOpenTicketForUser, getPanel, savePanel };
