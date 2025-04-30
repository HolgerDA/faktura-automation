require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const util = require('util');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ====== Middleware til rå data ======
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Autentificér og promisify Dropbox-kald
const dropbox = Dropbox.authenticate({
  token: process.env.DROPBOX_TOKEN,
  appSecret: process.env.DROPBOX_APP_SECRET
});
const dropboxAsync = util.promisify(dropbox);

// ====== Midlertidig cursor-lagring ======
let cursors = {}; // I produktion brug en rigtig database

// ====== Webhook endpoints ======
app.get('/webhook', (req, res) => {
  console.log('✅ Valideringsrequest modtaget');
  res.type('text').send(req.query.challenge);
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Filændringsnotifikation modtaget');

    // 1) Valider signatur
    const signature = req.header('x-dropbox-signature');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.DROPBOX_APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.log('🚨 Ugyldig signatur!');
      return res.status(403).send('Uautoriseret');
    }

    // 2) Loop over de konti, der har ændringer
    const accounts = req.body.list_folder?.accounts || [];
    for (const accountId of accounts) {
      console.log(`🔍 Behandler konto: ${accountId}`);

      try {
        // Hent cursor fra memory eller initialiser
        let cursor = cursors[accountId];
        if (!cursor) {
          const init = await dropboxAsync({
            resource: 'files/list_folder',
            parameters: { path: '', include_media_info: true }
          });
          cursor = init.cursor;
          cursors[accountId] = cursor;
        }

        // Hent kun ændringer siden sidst
        const changes = await dropboxAsync({
          resource: 'files/list_folder/continue',
          parameters: { cursor }
        });

        // Gem ny cursor
        cursors[accountId] = changes.cursor;

        // Bearbejd hver ændring (kun CSV-filer)
        if (Array.isArray(changes.entries)) {
          changes.entries.forEach(entry => {
            if (entry['.tag'] === 'file' && entry.name.endsWith('.csv')) {
              console.log(`📄 CSV-fil fundet: ${entry.name}`);
              // TODO: Tilføj din CSV-behandlings-logik her
            }
          });
        } else {
          console.log('⚠️ Ingen entries at behandle');
        }

      } catch (err) {
        console.error(`💥 Fejl ved behandling af konto ${accountId}:`, err);
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error('❌ Kritisk fejl i webhook:', err);
    res.status(500).send('Serverfejl');
  }
});

// ====== Server start ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server kører på port ${PORT}`);
  console.log(`🌐 Webhook URL: https://faktura-automation-production.up.railway.app/webhook`);
});
