require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();

// ================== KONFIGURATION ==================
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const dropbox = Dropbox.authenticate({
  token: process.env.DROPBOX_TOKEN,
  appSecret: process.env.DROPBOX_APP_SECRET
});

// ================== MIDLERTIDIG DATA ==================
let cursors = {}; // Erstat med database i produktion

// ================== HJÆLPEFUNKTIONER ==================
const getChanges = async (cursor) => {
  try {
    const response = await dropbox({
      resource: 'files/list_folder/continue',
      parameters: { cursor }
    }, (err, result) => {}).promise();

    console.log('✅ Dropbox API respons modtaget');
    return response;
  } catch (error) {
    console.error('❌ Dropbox API fejl:', error);
    return { entries: [] };
  }
};

// ================== WEBHOOK ENDPOINTS ==================
app.get('/webhook', (req, res) => {
  console.log('🔔 Valideringsrequest modtaget');
  res.type('text').send(req.query.challenge);
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('\n📬 Ny webhook-notifikation modtaget');
    
    // Valider signatur
    const signature = req.header('x-dropbox-signature');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.DROPBOX_APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.log('🚨 Ugyldig signatur - anmodning afvist');
      return res.status(403).send('Uautoriseret');
    }

    // Behandling af konti
    const accounts = req.body.list_folder?.accounts || [];
    console.log(`🔎 ${accounts.length} konti med ændringer`);

    for (const accountId of accounts) {
      console.log(`\n💼 Behandler konto: ${accountId}`);
      
      try {
        let cursor = cursors[accountId];
        
        // Hvis ingen cursor findes, hent initial
        if (!cursor) {
          console.log('⚙️ Henter initial cursor');
          const initResponse = await dropbox({
            resource: 'files/list_folder',
            parameters: { path: '/csv-filer' }
          }, (err, result) => {}).promise();
          
          cursor = initResponse.cursor;
          cursors[accountId] = cursor;
        }

        // Hent ændringer
        const changes = await getChanges(cursor);
        
        // Opdater cursor
        cursors[accountId] = changes.cursor;
        console.log(`🔄 Opdateret cursor: ${changes.cursor.slice(0, 15)}...`);

        // Behandler filændringer
        if (changes?.entries?.length > 0) {
          console.log(`📂 ${changes.entries.length} ændrede filer:`);
          
          changes.entries.forEach(entry => {
            if (entry?.['.tag'] === 'file' && entry?.name?.endsWith?.('.csv')) {
              console.log(`\n📄 CSV-fil fundet: ${entry.name}`);
              console.log('Sti:', entry.path_display);
              console.log('Ændringstid:', entry.server_modified);
              
              // ======== TILFØJ DIN BEHANDLINGSLOGIK HER ========
              // Eksempel: Hent fil, processer CSV, generer faktura
            }
          });
        } else {
          console.log('ℹ️ Ingen nye filændringer');
        }

      } catch (error) {
        console.error(`💥 Fejl i konto ${accountId}:`, error.message);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('‼️ Kritisk fejl:', error);
    res.status(500).send('Serverfejl');
  }
});

// ================== SERVER START ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Server kører på port ${PORT}`);
  console.log(`🌐 Webhook URL: ${process.env.RAILWAY_STATIC_URL}/webhook`);
  console.log('🔧 Konfiguration:');
  console.log('- Dropbox App Secret:', process.env.DROPBOX_APP_SECRET ? '✅' : '❌');
  console.log('- Dropbox Token:', process.env.DROPBOX_TOKEN ? '✅' : '❌');
});