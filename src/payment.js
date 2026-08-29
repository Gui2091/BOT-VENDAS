const { formatBRL } = require('./products');

async function createPixCharge(ticket, buyer) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) return null;
  const payerEmail = process.env.PAYMENT_PAYER_EMAIL?.trim();
  if (!payerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
    throw new Error('Defina PAYMENT_PAYER_EMAIL no .env com um e-mail válido antes de gerar cobranças PIX.');
  }

  const response = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `realrp-${ticket.channelId}`
    },
    body: JSON.stringify({
      transaction_amount: Number(ticket.total.toFixed(2)),
      description: `REAL RP — Pedido de ${buyer.username}`,
      payment_method_id: 'pix',
      payer: { email: payerEmail }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mercado Pago recusou a cobrança (${response.status}): ${error.slice(0, 180)}`);
  }

  const payment = await response.json();
  const transaction = payment.point_of_interaction?.transaction_data;
  if (!transaction?.qr_code) throw new Error('O Mercado Pago não retornou um código PIX para esta cobrança.');

  return {
    id: String(payment.id),
    copyPaste: transaction.qr_code,
    qrCodeBase64: transaction.qr_code_base64 || null,
    amount: formatBRL(ticket.total)
  };
}

async function getPixPaymentStatus(paymentId) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken || !paymentId) return null;

  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Não foi possível consultar o pagamento PIX (${response.status}).`);
  const payment = await response.json();
  return payment.status;
}

async function cancelPixCharge(paymentId) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken || !paymentId) return;
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' })
  });
  if (!response.ok && response.status !== 400) throw new Error(`Não foi possível cancelar o PIX no Mercado Pago (${response.status}).`);
}

module.exports = { createPixCharge, getPixPaymentStatus, cancelPixCharge };
