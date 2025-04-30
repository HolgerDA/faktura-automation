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
    
    const originalName = path.basename(sourcePath);
    const baseName = path.basename(originalName, '.csv');
    const ext = path.extname(originalName) || '.csv';
    const timestamp = Date.now();
    const newName = `${baseName}_${timestamp}${ext}`;
    const destinationPath = `${targetFolder}/${newName}`;

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
        }
        if (err) reject(err);
        else resolve(result);
      });
    });

    if (!folderList?.entries?.length) {
      console.log('📭 Mappen er tom');
      return res.sendStatus(200);
    }

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

    if (!latestFile.path_display) {
      console.error('🚫 Manglende sti i filobjekt');
      return res.status(500).send('Ugyldig filsti');
    }

    try {
      const csvContent = await downloadCSVFile(latestFile.path_display);
      const data = await parseCSVContent(csvContent);

      // Udpakning af data
      const {
        ProductId,
        Style,
        Name,
        Size,
        Amount,
        Locations,
        PurchasePriceDKK,
        RRP,
        TariffCode,
        CountryOfOrigin
      } = data;

      console.log('\n📋 Udpakket CSV-data:');
      console.log(`Product ID: ${ProductId}`);
      console.log(`Style: ${Style}`);
      console.log(`Name: ${Name}`);
      console.log(`Size: ${Size}`);
      console.log(`Amount: ${Amount}`);
      console.log(`Locations: ${Locations}`);
      console.log(`Purchase Price DKK: ${PurchasePriceDKK}`);
      console.log(`RRP: ${RRP}`);
      console.log(`Tariff Code: ${TariffCode}`);
      console.log(`Country of Origin: ${CountryOfOrigin}\n`);

      await moveCSVFile(latestFile.path_display, '/used csv-files');
      console.log('✅ Behandling gennemført');

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
    const parser = csv({
      headers: [
        'ProductId',
        'Style',
        'Name',
        'Size',
        'Amount',
        'Locations',
        'PurchasePriceDKK',
        'RRP',
        'TariffCode',
        'CountryOfOrigin'
      ],
      skipLines: 0
    })
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

    console.log('📂 Mappeindhold:', result?.entries?.length ? `${result.entries.length} filer` : 'Tom');
    
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