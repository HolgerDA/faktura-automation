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
    await new Promise(resolve => setTimeout(resolve, 2000));

    const folderPath = process.env.DROPBOX_INPUT_FOLDER || '/csv-filer';
    console.log('🔍 Checking folder:', folderPath);

    //Print af specifikke dele af API kald
    const folderList = await new Promise((resolve, reject) => {
        dropbox({
          resource: 'files/list_folder',
          parameters: { path: folderPath, limit: 10 }
        }, (err, result) => {
          console.log('📡 Rå API værdier:');
          
          if (result?.entries) {
            result.entries.forEach((entry, index) => {
              console.log(`📄 Fil ${index + 1}:`);
              console.log('- Navn:', entry.name);
              console.log('- Sti:', entry.path_lower);
              console.log('- Størrelse:', entry.size, 'bytes');
              console.log('- Sidst ændret:', entry.server_modified);
              console.log('- Type:', entry['.tag']);
              console.log('------------------------');
            });
          } else {
            console.log('❌ Ingen filer fundet i API respons');
          }
      
          if (err) reject(err);
          else resolve(result);
        });
      });

    // KORRIGERET: Fjern .result da responsen ikke er nested
    if (!folderList?.entries?.length) {
      console.log('📭 Mappen er tom');
      return res.sendStatus(200);
    }

    // KORRIGERET: Brug direkte entries fra responsen
    const latestFile = folderList.entries
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


    // Valider path_display
    if (!latestFile.path_display) {
      console.error('🚫 Manglende sti i filobjekt');
      return res.status(500).send('Ugyldig filsti');
    }

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

// ================== PARSE FUNKTION ==================
function parseCSVContent(csvData) {
  return new Promise((resolve, reject) => {
    const results = [];
    const parser = csv()
      .on('data', (data) => results.push(data))
      .on('end', () => {
        if (results.length === 0) return reject(new Error('Ingen data i CSV'));
        resolve(results[0]);
      })
      .on('error', reject);

    parser.write(csvData);
    parser.end();
  });
}

// ================== MAPPETJEK ==================
async function checkFolder() {
  try {
    const folderPath = process.env.DROPBOX_INPUT_FOLDER || '/csv-filer';
    const result = await new Promise((resolve, reject) => {
      dropbox({
        resource: 'files/list_folder',
        parameters: { path: folderPath }
      }, (err, res) => err ? reject(err) : resolve(res));
    });

    // KORRIGERET: Fjern .result
   
  } catch (error) {
    console.error('❌ Mappetjek fejlede:', error.message);
    console.error('💡 Tjek:');
    console.error('- Dropbox token rettigheder');
    console.error('- Mappesti eksistens');
    console.error('- Netværksforbindelse');
  }
}

// ================== SERVER START ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`\n🚀 Server startet på port ${PORT}`);
  console.log('🔧 Kontrollerer miljøvariabler:');
  console.log('- DROPBOX_APP_SECRET:', process.env.DROPBOX_APP_SECRET ? '✅' : '❌ Mangler');
  console.log('- DROPBOX_TOKEN:', process.env.DROPBOX_TOKEN ? '✅' : '❌ Mangler');
  
  await checkFolder();
});