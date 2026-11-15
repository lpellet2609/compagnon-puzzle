'use strict';
// Tâche programmée par Vercel (voir vercel.json) : rappel du soir, vers 19 h en Europe et à San Francisco.
const { eveningReminders } = require('./app.js');
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) { res.statusCode = 401; return res.end('Non autorisé'); }
  try {
    const out = await eveningReminders();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(out));
  } catch (e) { console.error(e); res.statusCode = 500; res.end('Erreur'); }
};
