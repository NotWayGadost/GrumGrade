'use strict';
// Provably fair: результат каждой игры = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}`).
// Игрок заранее видит sha256(serverSeed), сам задаёт clientSeed, а после смены сида
// получает serverSeed и может пересчитать любую прошлую игру. Подкрутить результат нельзя.
const crypto = require('crypto');

const newServerSeed = () => crypto.randomBytes(32).toString('hex');
const newClientSeed = () => crypto.randomBytes(8).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Число от 0 (включительно) до 1 (не включительно): первые 52 бита HMAC.
function roll(serverSeed, clientSeed, nonce) {
  const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}

module.exports = { newServerSeed, newClientSeed, sha256, roll };
