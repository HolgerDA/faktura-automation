require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ====== NYT: Tillad at læse rå data fra requests ======
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const dropbox = Dropbox.authenticate({
  token: process.env.DROPBOX_TOKEN,
  appSecret: process.env.DROPBOX_APP_SECRET
});

// ====== Webhook endpoints ======
app.get('/webhook', (req, res) => {
  console.log('✅ Fik GET-anmodning (validering)');
  res.type('text').send(req.query.challenge);
});

app.post('/webhook', async (req, res) => {
    try {
      console.log('📩 Fik POST-anmodning (filændring)');
      
      // Valider signatur
      const signature = req.header('x-dropbox-signature');
      const expectedSignature = crypto
        .createHmac('sha256', process.env.DROPBOX_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
  
      if (signature !== expectedSignature) {
        console.log('🚨 Ugyldig signatur!');
        return res.status(403).send('Ulovlig anmodning');
      }
  
      console.log('🔍 Kigger efter ændringer...');
      
      // KORREKT DATAUDTRÆK
      const accounts = req.body.list_folder?.accounts || [];
      
      accounts.forEach(accountId => {
        console.log('💼 Konto med ændringer:', accountId);
        // Her skal du kalde Dropbox API for at hente faktiske filændringer
        const cursor = await getCursorFromDB(); // Du skal gemme cursoren
const changes = await dropbox({
  resource: 'files/list_folder/continue',
  parameters: { cursor }
});

console.log('Ændrede filer:', changes.entries);

      });
  
      res.sendStatus(200);
    } catch (error) {
      console.log('💥 Fejl:', error);
      res.status(500).send('Serverfejl');
    }
  });

// ====== Start server ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server klar på port ${PORT}`);
  console.log(`🌐 Webhook URL: https://faktura-automation-production.up.railway.app/webhook`);
});