require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const crypto = require('crypto');
const csv = require('csv-parser');
const axios = require('axios');
const path = require('path');
const app = express();

// ================== KONFIGURATION ==================
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const dropbox = Dropbox.authenticate({
  token: process.env.DROPBOX_TOKEN
});

// ================== HJÆLPEFUNKTIONER ==================

async function downloadCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    console.log(`📥 Henter fil: ${filePath}`);
    
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) {
        console.error('❌ Fejl ved hentning af link:', err);
        return reject(err);
      }

      axios.get(result.link)
        .then(response => {
          console.log(`✅ Fil hentet (${response.data.length} tegn)`);
          resolve(response.data);
        })
        .catch(error => {
          console.error('❌ Download fejl:', error);
          reject(error);
        });
    });
  });
}

async function moveCSVFile(sourcePath, targetFolder) {
  return new Promise((resolve, reject) => {
    console.log(`🚚 Flytter fil til ${targetFolder}...`);
    
    const fileName = path.basename(sourcePath);
    const destinationPath = `${targetFolder}/${fileName}`;

    dropbox({
      resource: 'files/move_v2',
      parameters: {
        from_path: sourcePath,
        to_path: destinationPath,
        autorename: false
      }
    }, (err, result) => {
      if (err) {
        console.error('❌ Flyttefejl:', err);
        return reject(err);
      }
      console.log(`✅ Fil flyttet til: ${destinationPath}`);
      resolve(result);
    });
  });
}

// ================== WEBHOOK HANDLERING ==================
app.post('/webhook', async (req, res) => {
  try {
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

    console.log('🔔 Webhook modtaget - starter behandling');

    // List folder
    const folderList = await new Promise((resolve, reject) => {
      dropbox({
        resource: 'files/list_folder',
        parameters: {
          path: '/csv-filer',
          limit: 10 // Øget limit for safety
        }
      }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    // Tjek resultatstruktur
    if (!folderList?.result?.entries?.length) {
      console.log('📭 Mappen er tom');
      return res.sendStatus(200);
    }

    // Vælg den nyeste CSV fil
    const latestFile = folderList.result.entries
      .filter(file => 
        file['.tag'] === 'file' && 
        file.name.toLowerCase().endsWith('.csv')
      )
      .sort((a, b) => 
        new Date(b.server_modified) - new Date(a.server_modified)
      )[0];

    if (!latestFile) {
      console.log('⏭️ Ingen CSV-filer at behandle');
      return res.sendStatus(200);
    }

    console.log('🎯 Valgt fil:', latestFile.name);

    // Hent og processer fil
    try {
      const csvContent = await downloadCSVFile(latestFile.path_display);
      const data = await parseCSVContent(csvContent);
      await moveCSVFile(latestFile.path_display, '/used csv-files');
      console.log('✅ Behandling gennemført:', data);
    } catch (error) {
      console.error('💥 Fejl under behandling:', error);
      return res.status(500).send('Behandlingsfejl');
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('‼️ Kritisk fejl:', error);
    res.status(500).send('Serverfejl');
  }
});

// ================== TILFØJ PARSE FUNKTION ==================
function parseCSVContent(csvData) {
  return new Promise((resolve, reject) => {
    const results = [];
    const parser = csv()
      .on('data', (data) => results.push(data))
      .on('end', () => {
        if (results.length === 0) {
          return reject(new Error('Ingen data i CSV'));
        }
        resolve(results[0]);
      })
      .on('error', reject);

    parser.write(csvData);
    parser.end();
  });
}

// ================== SERVER START ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Server startet på port ${PORT}`);
  console.log('🔧 Kontrollerer miljøvariabler:');
  console.log('- DROPBOX_APP_SECRET:', process.env.DROPBOX_APP_SECRET ? '✅' : '❌ Mangler');
  console.log('- DROPBOX_TOKEN:', process.env.DROPBOX_TOKEN ? '✅' : '❌ Mangler');
});