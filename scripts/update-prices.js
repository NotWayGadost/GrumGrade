'use strict';
// Ручное обновление цен: npm run prices
require('../server/prices').updatePrices().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
