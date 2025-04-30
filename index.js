require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const crypto = require('crypto');
const csv = require('csv-parser');
const axios = require('axios');
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
 * Henter filindhold fra Dropbox
 * @param {string} filePath - Sti til filen i Dropbox
 */
async function downloadCSVFile(filePath) {
  try {
    console.log(`📥 Henter fil: ${filePath}`);
    
    // Får en midlertidig download link
    const { result } = await dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }).promise();

    // Download filindhold med axios
    const response = await axios.get(result.link);
    console.log(`✅ Fil hentet (${response.data.length} tegn)`);
    return response.data;
  } catch (error) {
    console.error('❌ Fejl ved hentning af fil:', error.message);
    throw error;
  }
}

/**
 * Parser CSV-indhold til variabler
 * @param {string} csvData - CSV tekstdata
 */
function parseCSVContent(csvData) {
  return new Promise((resolve, reject) => {
    console.log('🔍 Parser CSV-indhold...');
    const results = [];

    // Opret en CSV parser stream
    const parser = csv()
      .on('data', (data) => {
        console.log('📖 Læser række:', data);
        results.push(data);
      })
      .on('end', () => {
        if(results.length === 0) {
          reject(new Error('Ingen data rækker fundet i CSV'));
          return;
        }
        
        // Valider kolonner
        const expectedColumns = [
          'Product Id', 'Style', 'Name', 'Size', 'Amount',
          'Locations', 'Purchase Price DKK', 'RRP', 
          'Tariff Code', 'Country of Origin'
        ];
        
        const firstRow = results[0];
        const missingColumns = expectedColumns.filter(col => !(col in firstRow));
        
        if(missingColumns.length > 0) {
          reject(new Error(`Manglende kolonner: ${missingColumns.join(', ')}`));
          return;
        }

        console.log('✅ CSV parsing gennemført');
        resolve(firstRow);
      })
      .on('error', error => {
        console.error('❌ CSV parse fejl:', error.message);
        reject(error);
      });

    parser.write(csvData);
    parser.end();
  });
}

/**
 * Flytter en fil i Dropbox
 * @param {string} sourcePath - Original sti
 * @param {string} targetFolder - Mål mappe
 */
async function moveCSVFile(sourcePath, targetFolder) {
  try {
    console.log(`🚚 Flytter fil til ${targetFolder}...`);
    
    const fileName = path.basename(sourcePath);
    const destinationPath = `${targetFolder}/${fileName}`;

    await dropbox({
      resource: 'files/move_v2',
      parameters: {
        from_path: sourcePath,
        to_path: destinationPath,
        autorename: false
      }
    }).promise();

    console.log(`✅ Fil flyttet til: ${destinationPath}`);
  } catch (error) {
    console.error('❌ Fejl ved flytning af fil:', error.message);
    throw error;
  }
}


// ================== WEBHOOK HANDLERING ==================
app.post('/webhook', async (req, res) => {
    try {
      // Valider signatur (som før)
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
  
      // 1. List alle filer i /csv-filer
      const folderList = await dropbox({
        resource: 'files/list_folder',
        parameters: {
          path: '/csv-filer',
          limit: 1
        }
      }).promise();
  
      // 2. Tjek om der er filer at behandle
      if (!folderList.result?.entries?.length) {
        console.log('📭 Mappen er tom');
        return res.sendStatus(200);
      }
  
      // 3. Vælg den nyeste fil
      const latestFile = folderList.result.entries
        .filter(file => file['.tag'] === 'file' && file.name.endsWith('.csv'))
        .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified))[0];
  
      if (!latestFile) {
        console.log('⏭️ Ingen CSV-filer at behandle');
        return res.sendStatus(200);
      }
  
      console.log('🎯 Valgt fil:', latestFile.name);
  
      // 4. Hent og processer fil
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

// ================== SERVER START ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 Server startet på port ${PORT}`);
  console.log('🔧 Kontrollerer miljøvariabler:');
  console.log('- DROPBOX_APP_SECRET:', process.env.DROPBOX_APP_SECRET ? '✅' : '❌ Mangler');
  console.log('- DROPBOX_TOKEN:', process.env.DROPBOX_TOKEN ? '✅' : '❌ Mangler');
});