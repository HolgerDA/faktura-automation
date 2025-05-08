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
// Dropbox Client
// ======================
const dropbox = Dropbox.authenticate({ token: CONFIG.DROPBOX.TOKEN });

// ======================
// Logger Utility
// ======================
function log(message) {
  console.log(message);
}

// ======================
// File Operations
// ======================
async function getTemporaryLink(dropboxPath) {
  const result = await new Promise((resolve, reject) => {
    dropbox({ resource: 'files/get_temporary_link', parameters: { path: dropboxPath } },
      (err, res) => err ? reject(err) : resolve(res)
    );
  });
  return result.link;
}

async function downloadTextFile(dropboxPath) {
  log(`Reading CSV file: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  const response = await axios.get(link);
  log('CSV file downloaded from Dropbox');
  return response.data;
}

async function downloadBinaryFile(dropboxPath) {
  log(`Downloading template file: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  const response = await axios.get(link, { responseType: 'arraybuffer' });
  log('Template file downloaded successfully');
  return Buffer.from(response.data);
}

async function uploadBufferToDropbox(buffer, destinationPath, mimeType) {
  log(`Uploading final invoice to: ${destinationPath}`);
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
  log('Invoice upload complete');
}

async function moveDropboxFile(sourcePath, targetFolder) {
  const baseName = path.basename(sourcePath);
  log(`Archiving original CSV: ${sourcePath}`);
  const timestamp = Date.now();
  const destPath = `${targetFolder}/${baseName}_${timestamp}.csv`;
  await new Promise((resolve, reject) => {
    dropbox({ resource: 'files/move_v2', parameters: { from_path: sourcePath, to_path: destPath, autorename: false } },
      (err, res) => err ? reject(err) : resolve(res)
    );
  });
  log(`Moved and renamed CSV to processed folder: ${destPath}`);
}

// ======================
// CSV Parsing
// ======================
async function parseCSV(content) {
  log('Saving product data in temporary variable');
  return new Promise((resolve, reject) => {
    const rows = [];
    const parser = csvParser({
      separator: ';',
      mapHeaders: ({ header }) => header.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      mapValues: ({ value }) => (typeof value === 'string' ? value.trim().replace(/^"|"$/g, '') : value)
    });

    parser.on('data', data => rows.push(data));
    parser.on('end', () => {
      log('CSV parsing complete');
      resolve(rows);
    });
    parser.on('error', err => reject(err));
    const cleaned = content.split('\n').map(l => l.replace(/^"|"$/g, '')).join('\n');
    parser.write(cleaned);
    parser.end();
  });
}

// ======================
// Invoice Generation
// ======================
async function generateInvoice(products) {
  log('Preparing to generate new invoice file based on template');
  const templatePath = `${CONFIG.DROPBOX.FOLDERS.TEMPLATE}/Invoice-template.xlsx`;
  const templateBuffer = await downloadBinaryFile(templatePath);

  log('Filling out invoice with product data');
  const workbook = XLSX.read(templateBuffer, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];

  // Clean and save file name
  const baseName = products[0].fileName.replace(/\.csv$/, '');
  log(`Cleaning file name and saving to variable: ${baseName}`);
  XLSX.utils.sheet_add_aoa(worksheet, [[baseName]], { origin: 'B5' });

  // Insert product rows
  products.forEach((p, idx) => {
    const rowNumber = 13 + idx;
    XLSX.utils.sheet_add_aoa(worksheet, [[p.productId, p.style, p.productName, null, p.amount, p.rrp]], { origin: `A${rowNumber}` });
  });
  log('Populated invoice sheet with product details');

  // Rename invoice to customer name + timestamp
  log(`Renaming invoice file to customer name: ${baseName}`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const invoiceName = `${baseName}_${timestamp}.xlsx`;
  const invoicePath = `${CONFIG.DROPBOX.FOLDERS.INVOICE_OUTPUT}/${invoiceName}`;

  // Write buffer and upload
  const outBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  await uploadBufferToDropbox(outBuffer, invoicePath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  log(`Moved finished invoice to Teamsport-Invoice: ${invoicePath}`);
}

// ======================
// Webhook Handler
// ======================
const app = express();
app.use(express.json({ verify: (req, _, buf) => { req.raw = buf.toString(); } }));

app.post('/webhook', async (req, res) => {
  log('=== New webhook received ===');
  try {
    log('Validating webhook signature');
    const signature = req.header('x-dropbox-signature');
    const expected = crypto.createHmac('sha256', CONFIG.DROPBOX.APP_SECRET).update(req.raw).digest('hex');
    if (signature !== expected) {
      log('Signature did not match, aborting');
      return res.status(403).send('Unauthorized');
    }
    log('Webhook signature validated successfully');

    log('Waiting briefly for Dropbox to finish processing');
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY_MS));
    log('Security delay completed');

    log(`Listing files in folder: ${CONFIG.DROPBOX.FOLDERS.INPUT_CSV}`);
    const listRes = await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (err, result) => err ? reject(err) : resolve(result)
      );
    });

    const csvFiles = listRes.entries.filter(e => e['.tag'] === 'file' && e.name.endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (!csvFiles.length) {
      log('No CSV files found, nothing to do');
      return res.status(200).send('No files to process');
    }

    const latest = csvFiles[0];
    log(`Reads CSV file: ${latest.path_display}`);
    const csvContent = await downloadTextFile(latest.path_display);

    const records = await parseCSV(csvContent);

    log('Transforming records into product data');
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

    // Move original CSV out of the way
    await moveDropboxFile(latest.path_display, CONFIG.DROPBOX.FOLDERS.PROCESSED_CSV);

    // Generate invoice
    if (products.length) {
      await generateInvoice(products);
    }

    log('=== Processing complete ===');
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
    if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) throw new Error('Dropbox credentials missing');
    // Test connection
    await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (err, res) => err ? reject(err) : resolve(res)
      );
    });
    app.listen(CONFIG.SERVER_PORT, () => {
      log(`Server up and running on port ${CONFIG.SERVER_PORT}`);
      log('Configured Dropbox folders:');
      Object.entries(CONFIG.DROPBOX.FOLDERS).forEach(([key, val]) => log(`- ${key}: ${val}`));
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
})();
