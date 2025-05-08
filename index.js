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
const XLSX = require('xlsx');
const stream = require('stream');
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
 */
async function downloadCSVFile(filePath) {
  console.log(`Downloading CSV file from Dropbox: ${filePath}`);
  return new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) {
        console.error('Error getting temporary link for CSV:', err);
        return reject(err);
      }
      axios.get(result.link)
        .then(response => {
          console.log('CSV download complete');
          resolve(response.data);
        })
        .catch(error => {
          console.error('Error fetching CSV from temporary link:', error);
          reject(error);
        });
    });
  });
}

/**
 * Moves processed file to archive folder
 */
async function archiveProcessedFile(sourcePath) {
  console.log(`Archiving processed file: ${sourcePath}`);
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
      if (err) {
        console.error('Error archiving file:', err);
        reject(err);
      } else {
        console.log(`Add timestamp to csv filename, and move to folder "${CONFIG.DROPBOX.PROCESSED_FOLDER}": ${destinationPath}`);
        resolve(result);
      }
    });
  });
}

/**
 * Downloads any file from Dropbox as Buffer
 */
async function downloadFile(filePath) {
  console.log(`Downloading file from Dropbox (binary): ${filePath}`);
  return new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) {
        console.error('Error getting temporary link for file:', err);
        return reject(err);
      }
      axios.get(result.link, { responseType: 'arraybuffer' })
        .then(response => {
          console.log('File download complete');
          resolve(Buffer.from(response.data));
        })
        .catch(error => {
          console.error('Error fetching file from temporary link:', error);
          reject(error);
        });
    });
  });
}

/**
 * Generates Excel invoice from product data
 */
async function generateInvoiceFile(products) {
  console.log('Starting invoice file generation, based on the template from "template" folder');
  try {
    const templateBuffer = await downloadFile('/template/Invoice-template.xlsx');
    console.log('Copy of invoice template completed successfully');

    const workbook = XLSX.read(templateBuffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // Extract the base filename without .csv extension
    const baseName = products[0].fileName.replace(/\.csv$/, '');

    // Insert the base filename into cell B5
    XLSX.utils.sheet_add_aoa(worksheet, [[baseName]], { origin: 'B5' });

    // Add product data starting from row 13
    products.forEach((product, index) => {
      const row = 13 + index;
      XLSX.utils.sheet_add_aoa(worksheet, [
        [
          product.productId,
          product.style,
          product.productName,
          null,
          product.amount,
          product.rrp
        ]
      ], { origin: `A${row}` });
    });
    console.log('Transformation and temporary storing of product data in invoice sheet complete');

    const excelBuffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx'
    });

    // Generate the invoice filename with timestamp
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${baseName}_${iso}.xlsx`;
    const destinationPath = `/Teamsport-Invoice/${fileName}`;

    // Upload the generated invoice
    console.log(`Uploading generated invoice to: ${destinationPath}`);
    await new Promise((resolve, reject) => {
      const uploadStream = dropbox({
        resource: 'files/upload',
        parameters: {
          path: destinationPath,
          mode: 'overwrite',
          autorename: false
        },
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
      }, (err, result) => {
        if (err) {
          console.error('Error uploading invoice file:', err);
          reject(err);
        } else {
          console.log(`Fakturafil oprettet: ${destinationPath}`);
          resolve(result);
        }
      });

      const bufferStream = new stream.PassThrough();
      bufferStream.end(excelBuffer);
      bufferStream.pipe(uploadStream);
    });
  } catch (error) {
    console.error('Fejl under generering af fakturafil:', error);
    throw error;
  }
}

// ======================
// CSV Processing
// ======================
function parseCSVContent(csvData) {
  console.log('Starting data processing: parsing CSV content');
  return new Promise((resolve, reject) => {
    const results = [];
    const parser = csv({
      separator: ';',
      mapHeaders: ({ header }) => header
        .trim()
        .replace(/["\\]/g, '')
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .toLowerCase(),
      mapValues: ({ value }) => typeof value === 'string'
        ? value.replace(/^"|"$/g, '').trim()
        : value
    });

    parser
      .on('data', data => results.push(data))
      .on('end', () => {
        console.log('CSV parsing complete');
        resolve(results);
      })
      .on('error', err => {
        console.error('Error parsing CSV:', err);
        reject(err);
      });

    const cleanedCsv = csvData
      .split('\n')
      .map(line => line.trim().replace(/^"|"$/g, ''))
      .join('\n');

    parser.write(cleanedCsv);
    parser.end();
  });
}

// ======================
// Webhook Handler 
// ======================
app.post('/webhook', async (req, res) => {
  console.log('=== New webhook received ===');

  try {
    // Validate webhook signature
    console.log('Validating webhook signature...');
    const signature = req.header('x-dropbox-signature');
    const expectedSignature = crypto
      .createHmac('sha256', CONFIG.DROPBOX.APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('Webhook signature validation failed');
      return res.status(403).send('Unauthorized');
    }
    console.log('Webhook signature validated successfully');

    // Security delay
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY));
    console.log('Security delay completed');

    // List folder contents
    console.log(`Checking Dropbox folder: ${CONFIG.DROPBOX.INPUT_FOLDER}`);
    const folderContents = await new Promise((resolve, reject) => {
      dropbox({
        resource: 'files/list_folder',
        parameters: {
          path: CONFIG.DROPBOX.INPUT_FOLDER,
          limit: 10
        }
      }, (err, result) => err ? reject(err) : resolve(result));
    });

    // Filter CSV files
    const csvFiles = folderContents.entries
      .filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (csvFiles.length === 0) {
      console.log('No CSV files to process');
      return res.status(200).send('No files to process');
    }

    // Download and parse latest CSV
    const targetFile = csvFiles[0];
    const csvContent = await downloadCSVFile(targetFile.path_display);
    console.log('CSV Data Received - check');

    const parsedData = await parseCSVContent(csvContent);

    // Transform data
    console.log('Starting data processing: transforming records');
    const products = parsedData.map(item => {
      const parseNumber = str => {
        const cleaned = str.replace(/[^0-9,]/g, '').replace(',', '.');
        return cleaned ? parseFloat(cleaned) : 0;
      };
      return {
        fileName: targetFile.name,
        productId: item.product_id,
        style: item.style,
        productName: item.name,
        size: item.size,
        amount: parseInt(item.amount, 10) || 0,
        locations: item.locations.split('-').map(l => l.trim()),
        purchasePriceDKK: parseNumber(item.purchase_price_dkk),
        rrp: parseNumber(item.rrp),
        tariffCode: item.tariff_code,
        countryOfOrigin: item.country_of_origin
      };
    });
    console.log('Transformation and temporary storing of product data in local variables complete');

    // Generate invoice
    if (products.length > 0) {
      await generateInvoiceFile(products);
    }

    // Archive original CSV
    await archiveProcessedFile(targetFile.path_display);

    console.log('All steps completed successfully');
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
  console.log('Initializing server...');
  // Validate env vars
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
    console.log('Dropbox connection verified');
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
