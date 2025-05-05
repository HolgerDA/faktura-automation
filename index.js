// ======================
// Environment Setup
// ======================
require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const crypto = require('crypto');
const csv = require('csv-parser');
const axios = require('axios');
const path = require('path');
const app = express();

// ======================
// Configuration Constants
// ======================
const CONFIG = {
  SERVER_PORT: process.env.PORT || 8080,
  DROPBOX: {
    TOKEN: process.env.DROPBOX_TOKEN,
    APP_SECRET: process.env.DROPBOX_APP_SECRET,
    INPUT_FOLDER: process.env.DROPBOX_INPUT_FOLDER || '/csv-filer',
    PROCESSED_FOLDER: process.env.DROPBOX_PROCESSED_FOLDER || '/processed-csv-files'
  },
  SECURITY: {
    WEBHOOK_DELAY: 2000 // 2 second processing delay
  }
};

// ======================
// Dropbox Client Setup
// ======================
const dropbox = Dropbox.authenticate({
  token: CONFIG.DROPBOX.TOKEN
});

// ======================
// Middleware Configuration
// ======================
app.use(express.json({
  verify: (req, _, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ======================
// File Operations
// ======================

/**
 * Downloads CSV file from Dropbox
 * @param {string} filePath - Full Dropbox path to CSV file
 */
async function downloadCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) return reject(err);
      axios.get(result.link)
        .then(response => resolve(response.data))
        .catch(reject);
    });
  });
}

/**
 * Moves processed file to archive folder
 * @param {string} sourcePath - Original file path
 */
async function archiveProcessedFile(sourcePath) {
  return new Promise((resolve, reject) => {
    const originalName = path.basename(sourcePath);
    const timestamp = Date.now();
    const destinationPath = `${CONFIG.DROPBOX.PROCESSED_FOLDER}/${originalName}_${timestamp}.csv`;

    dropbox({
      resource: 'files/move_v2',
      parameters: {
        from_path: sourcePath,
        to_path: destinationPath,
        autorename: false
      }
    }, (err, result) => {
      err ? reject(err) : resolve(result);
    });
  });
}

// ======================
// CSV Processing
// ======================

/**
 * Parses CSV content to JSON
 */
function parseCSVContent(csvData) {
    return new Promise((resolve, reject) => {
      const results = [];
      const parser = csv({ separator: ';' });
  
      parser
        .on('data', (data) => results.push(data))
        .on('end', () => resolve(results))
        .on('error', reject);
  
      // Skriv data til parseren korrekt
      parser.write(csvData);
      parser.end();
    });
  }

// ======================
// Webhook Handler
// ======================
app.post('/webhook', async (req, res) => {
  try {
    // Validate webhook signature
    const signature = req.header('x-dropbox-signature');
    const expectedSignature = crypto
      .createHmac('sha256', CONFIG.DROPBOX.APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      return res.status(403).send('Unauthorized');
    }

    // Allow time for file processing in Dropbox
    await new Promise(resolve => 
      setTimeout(resolve, CONFIG.SECURITY.WEBHOOK_DELAY)
    );

    // Get latest CSV file
    const folderContents = await new Promise((resolve, reject) => {
      dropbox({
        resource: 'files/list_folder',
        parameters: { 
          path: CONFIG.DROPBOX.INPUT_FOLDER,
          limit: 10 
        }
      }, (err, result) => err ? reject(err) : resolve(result));
    });

    const csvFiles = folderContents.entries
      .filter(file => 
        file['.tag'] === 'file' && 
        file.name.toLowerCase().endsWith('.csv')
      )
      .sort((a, b) => 
        new Date(b.server_modified) - new Date(a.server_modified)
      );

    if (csvFiles.length === 0) {
      return res.status(200).send('No files to process');
    }

    const targetFile = csvFiles[0];
    const csvContent = await downloadCSVFile(targetFile.path_display);
    const parsedData = await parseCSVContent(csvContent);

    // Log raw CSV data
    console.log('CSV Data Received:', JSON.stringify(parsedData, null, 2));
    // --- map til "venlige" variabelnavne ---
const mapped = parsedData.map(item => ({
    productId:            item['Product Id'],
    style:                item.Style,
    productName:          item.Name,
    size:                 item.Size,
    amount:               Number(item.Amount),
    locations:            item.Locations,
    purchasePriceDKK:     parseFloat(item['Purchase Price DKK'].replace(',', '.')),
    rrp:                  parseFloat(item.RRP.replace(',', '.')),
    tariffCode:           item['Tariff Code'],
    countryOfOrigin:      item['Country of Origin']
  }));
  
  // --- tag første record ud til individuelle variabler ---
  const {
    productId,
    style,
    productName,
    size,
    amount,
    locations,
    purchasePriceDKK,
    rrp,
    tariffCode,
    countryOfOrigin
  } = mapped[0];
  
  // nu kan du bruge:
  // productId, style, productName, size, amount, locations,
  // purchasePriceDKK, rrp, tariffCode, countryOfOrigin
  console.log({ productId, style, productName, size, amount });
  


    // Archive processed file
    await archiveProcessedFile(targetFile.path_display);
    
    res.status(200).send('Processing complete');
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).send('Internal server error');
  }
});

// ======================
// Server Initialization
// ======================
async function initializeServer() {
  // Validate environment variables
  if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) {
    throw new Error('Missing required Dropbox environment variables');
  }

  // Verify Dropbox connection
  try {
    await new Promise((resolve, reject) => {
      dropbox({
        resource: 'files/list_folder',
        parameters: { path: CONFIG.DROPBOX.INPUT_FOLDER }
      }, (err, res) => err ? reject(err) : resolve(res));
    });
  } catch (error) {
    throw new Error(`Dropbox connection failed: ${error.message}`);
  }

  app.listen(CONFIG.SERVER_PORT, () => {
    console.log(`Server running on port ${CONFIG.SERVER_PORT}`);
    console.log('Configured folders:');
    console.log('- Input:', CONFIG.DROPBOX.INPUT_FOLDER);
    console.log('- Archive:', CONFIG.DROPBOX.PROCESSED_FOLDER);
  });
}

// Start the application
initializeServer().catch(error => {
  console.error('Server initialization failed:', error.message);
  process.exit(1);
});