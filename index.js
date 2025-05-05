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
// CSV Processing (opdateret)
// ======================

function parseCSVContent(csvData) {
    return new Promise((resolve, reject) => {
      const results = [];
      const parser = csv({
        separator: ';',
        mapHeaders: ({ header }) => {
          return header
            .trim()
            .replace(/["\\]/g, '')    // fjern quotes & backslashes
            .replace(/\s+/g, '_')     // spaces → underscore
            .replace(/[^a-zA-Z0-9_]/g, '') // alfanumerisk + underscore only
            .toLowerCase();
        },
        mapValues: ({ value }) => {
          return typeof value === 'string'
            ? value.replace(/^"|"$/g, '').trim()
            : value;
        }
      });
  
      parser
        .on('data', data => results.push(data))
        .on('end', () => resolve(results))
        .on('error', reject);
  
      // Fjern overflødige quotes fra hele CSV-indholdet
      const cleanedCsv = csvData
        .split('\n')
        .map(line => line.trim().replace(/^"|"$/g, ''))
        .join('\n');
  
      parser.write(cleanedCsv);
      parser.end();
    });
  }
  
  // ======================
  // Webhook Handler (opdateret del)
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
  
      // Vent lidt for at Dropbox når at færdigbehandle filerne
      await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY));
  
      // Hent seneste CSV i input-mappen
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
        .filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith('.csv'))
        .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));
  
      if (csvFiles.length === 0) {
        return res.status(200).send('No files to process');
      }
  
      const targetFile = csvFiles[0];
      const csvContent = await downloadCSVFile(targetFile.path_display);
      const parsedData = await parseCSVContent(csvContent);
  
      console.log('CSV Data Received:', JSON.stringify(parsedData, null, 2));
  
      // Data transformation med korrekt typekonvertering
      const products = parsedData.map(item => {
        const parseNumber = str => {
          const cleaned = str.replace(/[^0-9,]/g, '').replace(',', '.');
          return cleaned ? parseFloat(cleaned) : 0;
        };
  
        return {
          productId:         item.product_id,
          style:             item.style,
          productName:       item.name,
          size:              item.size,
          amount:            parseInt(item.amount, 10) || 0,
          locations:         item.locations.split('-').map(l => l.trim()),
          purchasePriceDKK:  parseNumber(item.purchase_price_dkk),
          rrp:               parseNumber(item.rrp),
          tariffCode:        item.tariff_code,
          countryOfOrigin:   item.country_of_origin
        };
      });
  
      console.log('Processerede produkter:', JSON.stringify(products, null, 2));
  
      const totalValue = products
        .reduce((sum, p) => sum + (p.amount * p.purchasePriceDKK), 0);
  
      console.log(`Total lagerbeholdning værdi: ${totalValue.toFixed(2)} DKK`);
  
      // Flyt fil til arkiv
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