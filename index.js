require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
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

const dropbox = Dropbox.authenticate({
  token: process.env.DROPBOX_TOKEN,
  appSecret: process.env.DROPBOX_APP_SECRET
});

// ====== Midlertidig cursor-lagring ======
let cursors = {}; // Erstat med database i produktion

// ====== Webhook endpoints ======
app.get('/webhook', (req, res) => {
  console.log('✅ Valideringsrequest modtaget');
  res.type('text').send(req.query.challenge);
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Filændringsnotifikation modtaget');
    
    // Valider signatur
    const signature = req.header('x-dropbox-signature');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.DROPBOX_APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.log('🚨 Ugyldig signatur!');
      return res.status(403).send('Uautoriseret');
    }

    // Behandling af konti med ændringer
    const accounts = req.body.list_folder?.accounts || [];
    
    for (const accountId of accounts) {
      console.log(`🔍 Behandler konto: ${accountId}`);
      
      try {
        // Hent eller initialiser cursor
        let cursor = cursors[accountId];
        
        if (!cursor) {
          // Første gang - hent initial cursor
          const initResponse = await dropbox({
            resource: 'files/list_folder',
            parameters: {
              path: '',
              include_hashes: true
            }
          });
          cursor = initResponse.cursor;
          cursors[accountId] = cursor;
        }

        // Hent ændringer
        const changes = await dropbox({
          resource: 'files/list_folder/continue',
          parameters: { cursor }
        });

        // Opdater cursor
        cursors[accountId] = changes.cursor;

        // Behandler ændrede filer
        changes.entries.forEach(entry => {
          if (entry['.tag'] === 'file' && entry.name.endsWith('.csv')) {
            console.log(`📄 CSV-fil fundet: ${entry.name}`);
            // Tilføj din filbehandlingslogik her
          }
        });

      } catch (error) {
        console.error(`💥 Fejl ved behandling af ${accountId}:`, error);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Kritisk fejl:', error);
    res.status(500).send('Serverfejl');
  }
});

// ====== Server start ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server kører på port ${PORT}`);
  console.log(`🌐 Webhook URL: https://faktura-automation-production.up.railway.app/webhook`);
});