// ======================
// Environment Setup
// ======================
require('dotenv').config();
const express = require('express');
const Dropbox = require('dropbox-v2-api');
const crypto = require('crypto');
const csvParser = require('csv-parser');
const axios = require('axios');
const path = require('path');
const XLSX = require('xlsx');
const stream = require('stream');

// ======================
// Configuration
// ======================
const CONFIG = {
  SERVER_PORT: process.env.PORT || 8080,
  DROPBOX: {
    TOKEN: process.env.DROPBOX_TOKEN,
    APP_SECRET: process.env.DROPBOX_APP_SECRET,
    FOLDERS: {
      INPUT_CSV: process.env.DROPBOX_INPUT_FOLDER || '/csv-filer',
      PROCESSED_CSV: process.env.DROPBOX_PROCESSED_FOLDER || '/processed-csv-files',
      TEMPLATE: process.env.DROPBOX_TEMPLATE_FOLDER || '/template',
      INVOICE_OUTPUT: process.env.DROPBOX_INVOICE_FOLDER || '/Teamsport-Invoice'
    }
  },
  SECURITY: {
    WEBHOOK_DELAY_MS: 2000
  }
};

// ======================
// Dropbox Client Setup
// ======================
const dropbox = Dropbox.authenticate({ token: CONFIG.DROPBOX.TOKEN });

// ======================
// Logger Utility
// ======================
// A simple logger function to unify log output
function log(message) {
  console.log(message);
}

// ======================
// File Operations
// ======================
// Retrieve a temporary download link for any Dropbox path
async function getTemporaryLink(dropboxPath) {
  const result = await new Promise((resolve, reject) => {
    dropbox({ resource: 'files/get_temporary_link', parameters: { path: dropboxPath } },
      (err, res) => err ? reject(err) : resolve(res)
    );
  });
  return result.link;
}

// Download a CSV file as text and log each sub-step
async function downloadTextFile(dropboxPath) {
  log(`Step: Starting to read the CSV file from Dropbox at path: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  log('Step: Received temporary link for CSV download');
  const response = await axios.get(link);
  log('Step: CSV file content downloaded successfully');
  return response.data;
}

// Download a binary file (invoice template) and log each sub-step
async function downloadBinaryFile(dropboxPath) {
  log(`Step: Downloading invoice template file from Dropbox at path: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  log('Step: Received temporary link for template file download');
  const response = await axios.get(link, { responseType: 'arraybuffer' });
  log('Step: Invoice template file downloaded into memory');
  return Buffer.from(response.data);
}

// Upload a buffer (generated invoice) to Dropbox
async function uploadBufferToDropbox(buffer, destinationPath, mimeType) {
  log(`Step: Uploading the generated invoice to Dropbox at path: ${destinationPath}`);
  await new Promise((resolve, reject) => {
    const uploadStream = dropbox({
      resource: 'files/upload',
      parameters: { path: destinationPath, mode: 'overwrite', autorename: false },
      headers: { 'Content-Type': mimeType }
    }, (err, res) => err ? reject(err) : resolve(res));

    const pass = new stream.PassThrough();
    pass.end(buffer);
    pass.pipe(uploadStream);
  });
  log('Step: Invoice file upload completed');
}

// Move and rename the processed CSV file to the 'processed' folder
async function moveDropboxFile(sourcePath, targetFolder) {
  const baseName = path.basename(sourcePath);
  log(`Step: Archiving the original CSV file: ${sourcePath}`);
  const timestamp = Date.now();
  const newName = `${baseName}_${timestamp}.csv`;
  const destPath = `${targetFolder}/${newName}`;

  await new Promise((resolve, reject) => {
    dropbox({ resource: 'files/move_v2', parameters: { from_path: sourcePath, to_path: destPath, autorename: false } },
      (err, res) => err ? reject(err) : resolve(res)
    );
  });

  log(`Step: Original CSV moved and renamed to processed folder as: ${destPath}`);
  return destPath;
}

// ======================
// CSV Parsing
// ======================
// Parse CSV content into JS objects and store temporarily
async function parseCSV(content) {
  log('Step: Parsing CSV content into product records');
  return new Promise((resolve, reject) => {
    const rows = [];
    const parser = csvParser({
      separator: ';',
      mapHeaders: ({ header }) => header.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      mapValues: ({ value }) => (typeof value === 'string' ? value.trim().replace(/^"|"$/g, '') : value)
    });

    parser.on('data', data => rows.push(data));
    parser.on('end', () => {
      log(`Step: Completed CSV parsing, saved ${rows.length} rows in temporary variable`);
      resolve(rows);
    });
    parser.on('error', err => reject(err));

    // Clean up extra quotes before parsing
    const cleaned = content.split('\n').map(line => line.replace(/^"|"$/g, '')).join('\n');
    parser.write(cleaned);
    parser.end();
  });
}

// ======================
// Invoice Generation
// ======================
// Using the parsed products, fill out and save an invoice
async function generateInvoice(products) {
  log('Step: Starting invoice generation based on template');
  const templatePath = `${CONFIG.DROPBOX.FOLDERS.TEMPLATE}/Invoice-template.xlsx`;

  // Download and read template
  const templateBuffer = await downloadBinaryFile(templatePath);
  log('Step: Loaded the invoice template into a workbook object');

  const workbook = XLSX.read(templateBuffer, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];

  // Extract and clean base filename for invoice naming
  const rawName = products[0].fileName;
  log(`Step: Extracting base filename from CSV: ${rawName}`);
  const baseName = rawName.replace(/\.csv$/, '');
  log(`Step: Cleaned base filename saved as: ${baseName}`);

  // Insert baseName into invoice template cell B5
  XLSX.utils.sheet_add_aoa(worksheet, [[baseName]], { origin: 'B5' });
  log('Step: Inserted cleaned filename into template cell B5');

  // Fill out product lines starting at row 13
  products.forEach((p, idx) => {
    const rowNumber = 13 + idx;
    XLSX.utils.sheet_add_aoa(worksheet, [[p.productId, p.style, p.productName, null, p.amount, p.rrp]], { origin: `A${rowNumber}` });
  });
  log('Step: Populated invoice rows with product data');

  // Generate invoice filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const invoiceName = `${baseName}_${timestamp}.xlsx`;
  const invoicePath = `${CONFIG.DROPBOX.FOLDERS.INVOICE_OUTPUT}/${invoiceName}`;
  log(`Step: Generated invoice filename with customer name and timestamp: ${invoiceName}`);

  // Write and upload the invoice
  const outBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  await uploadBufferToDropbox(outBuffer, invoicePath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  log(`Step: Finished invoice moved to Teamsport-Invoice folder at: ${invoicePath}`);
}

// ======================
// Webhook Handler
// ======================
const app = express();
app.use(express.json({ verify: (req, _, buf) => { req.raw = buf.toString(); } }));

app.post('/webhook', async (req, res) => {
  log('=== New webhook received ===');
  try {
    // 1) Validate signature
    log('Step: Validating webhook signature using app secret');
    const signature = req.header('x-dropbox-signature');
    const expected = crypto.createHmac('sha256', CONFIG.DROPBOX.APP_SECRET).update(req.raw).digest('hex');
    if (signature !== expected) {
      log('Step: Signature mismatch detected, rejecting request');
      return res.status(403).send('Unauthorized');
    }
    log('Step: Webhook signature validated successfully');

    // 2) Wait for Dropbox to complete file write
    log('Step: Waiting briefly for Dropbox to finalize file operations');
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY_MS));
    log('Step: Security delay complete');

    // 3) List CSV files in input folder
    log(`Step: Listing CSV files in folder: ${CONFIG.DROPBOX.FOLDERS.INPUT_CSV}`);
    const listRes = await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (err, result) => err ? reject(err) : resolve(result)
      );
    });

    const csvFiles = listRes.entries
      .filter(e => e['.tag'] === 'file' && e.name.endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (!csvFiles.length) {
      log('Step: No CSV files found - ending process');
      return res.status(200).send('No files to process');
    }

    // 4) Read and parse latest CSV
    const latest = csvFiles[0];
    log(`Step: Selected latest CSV file for processing: ${latest.path_display}`);
    const csvContent = await downloadTextFile(latest.path_display);

    const records = await parseCSV(csvContent);
    log(`Step: Parsed CSV into ${records.length} product records`);

    // 5) Transform raw records into structured product data
    const products = records.map(r => ({
      fileName: latest.name,
      productId: r.product_id,
      style: r.style,
      productName: r.name,
      size: r.size,
      amount: parseInt(r.amount, 10) || 0,
      locations: r.locations.split('-').map(l => l.trim()),
      purchasePriceDKK: parseFloat(r.purchase_price_dkk.replace(',', '.')) || 0,
      rrp: parseFloat(r.rrp.replace(',', '.')) || 0,
      tariffCode: r.tariff_code,
      countryOfOrigin: r.country_of_origin
    }));
    log('Step: Transformed CSV rows into internal product data structure');

    // 6) Archive the original CSV
    await moveDropboxFile(latest.path_display, CONFIG.DROPBOX.FOLDERS.PROCESSED_CSV);

    // 7) Generate and upload invoice based on product data
    if (products.length) {
      await generateInvoice(products);
    }

    log('=== All processing steps completed successfully ===');
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error during webhook processing:', error);
    res.status(500).send('Internal server error');
  }
});

// ======================
// Server Startup
// ======================
(async function start() {
  try {
    if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) throw new Error('Missing Dropbox credentials');
    // Verify connection
    await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (err, res) => err ? reject(err) : resolve(res)
      );
    });
    app.listen(CONFIG.SERVER_PORT, () => {
      log(`Starting Container`);
      log(`Server up and listening on port ${CONFIG.SERVER_PORT}`);
      log('Configured Dropbox folders:');
      Object.entries(CONFIG.DROPBOX.FOLDERS).forEach(([key, val]) => log(`- ${key}: ${val}`));
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
})();
