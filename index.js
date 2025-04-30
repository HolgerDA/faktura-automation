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

/**
 * Henter filindhold fra Dropbox (Opdateret)
 */
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
  
  /**
   * Flytter fil i Dropbox (Opdateret)
   */
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
  
  // ================== WEBHOOK HANDLERING (Opdateret) ==================
  app.post('/webhook', async (req, res) => {
    try {
      // ... Validering som før ...
  
      console.log('🔔 Webhook modtaget - starter behandling');
  
      // List folder med callback
      const folderList = await new Promise((resolve, reject) => {
        dropbox({
          resource: 'files/list_folder',
          parameters: {
            path: '/csv-filer',
            limit: 1
          }
        }, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
  
      // Tjek resultatstruktur
      if (!folderList?.entries?.length) {
        console.log('📭 Mappen er tom');
        return res.sendStatus(200);
      }
  
      // ... resten af koden uændret ...
    } catch (error) {
      console.error('‼️ Kritisk fejl:', error);
      res.status(500).send('Serverfejl');
    }
  });

// ================== SERVER START ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Server startet på port ${PORT}`);
  console.log('🔧 Kontrollerer miljøvariabler:');
  console.log('- DROPBOX_APP_SECRET:', process.env.DROPBOX_APP_SECRET ? '✅' : '❌ Mangler');
  console.log('- DROPBOX_TOKEN:', process.env.DROPBOX_TOKEN ? '✅' : '❌ Mangler');
});