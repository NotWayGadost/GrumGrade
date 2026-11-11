'use strict';
// Платёжная система — ЗАГЛУШКА.
//
// ВАЖНО: приём реальных денег за апгрейды и кейсы — это азартные игры. Для этого нужна
// лицензия в юрисдикции, где работает сайт (в РФ онлайн-казино без лицензии запрещены).
// Платёжные провайдеры тоже спросят лицензию. Подключайте только после решения этого вопроса.
//
// Как подключить провайдера, когда будет можно:
//   1. createPayment() создаёт счёт у провайдера и возвращает { url } для редиректа игрока.
//   2. Провайдер шлёт вебхук на POST /api/payments/webhook.
//   3. handleWebhook() ОБЯЗАТЕЛЬНО проверяет подпись провайдера, затем вызывает
//      creditDeposit(userId, amountKopecks, paymentId). Повторный вебхук с тем же paymentId
//      баланс второй раз не начислит (уникальный индекс в ledger).
const { db, tx } = require('./db');

const qCredit = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');
const qLedger = db.prepare("INSERT INTO ledger(user_id, type, amount, ref, created_at) VALUES (?, 'deposit', ?, ?, ?)");

function creditDeposit(userId, amount, paymentId) {
  try {
    tx(() => { qLedger.run(userId, amount, String(paymentId), Date.now()); qCredit.run(amount, userId); });
    return true;
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return false; // уже зачислено
    throw e;
  }
}

const configured = () => false;

async function createPayment(/* user, amountKopecks */) {
  const e = new Error('Пополнение пока не подключено'); e.status = 501; throw e;
}

async function handleWebhook(/* rawBody, headers */) {
  const e = new Error('Webhook не настроен'); e.status = 501; throw e;
}

module.exports = { configured, createPayment, handleWebhook, creditDeposit };
