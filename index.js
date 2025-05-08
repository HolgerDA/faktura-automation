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
function log(message) {
  console.log(message);
}

// ======================
// File Operations
// ======================
async function getTemporaryLink(dropboxPath) {
  const result = await new Promise((resolve, reject) => {
    dropbox({ resource: 'files/get_temporary_link', parameters: { path: dropboxPath } },
      (err, res) => err ? reject(err) : resolve(res));
  });
  return result.link;
}

async function downloadTextFile(dropboxPath) {
  log(`📄 Fetching CSV file via API link: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  log('🔗 Temporary download link obtained from Dropbox');
  const response = await axios.get(link);
  log('📥 CSV content successfully downloaded into memory');
  return response.data;
}

async function downloadBinaryFile(dropboxPath) {
  log(`📑 Fetching latest invoice template from: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  log('🔗 Temporary download link for template obtained');
  const response = await axios.get(link, { responseType: 'arraybuffer' });
  log('📥 Template file downloaded into buffer');
  return Buffer.from(response.data);
}

async function uploadBufferToDropbox(buffer, destinationPath, mimeType) {
  log(`🚀 Uploading finished invoice to Dropbox: ${destinationPath}`);
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
  log('✅ Invoice upload complete – Finance team now has access');
}

async function moveDropboxFile(sourcePath, targetFolder) {
  const baseName = path.basename(sourcePath);
  log('📦 Archiving original CSV file and appending timestamp to avoid name collisions');
  const timestamp = Date.now();
  const destPath = `${targetFolder}/${baseName}_${timestamp}.csv`;
  await new Promise((resolve, reject) => {
    dropbox({ resource: 'files/move_v2', parameters: { from_path: sourcePath, to_path: destPath, autorename: false } },
      (err, res) => err ? reject(err) : resolve(res));
  });
  log(`✅ CSV successfully moved to processed folder as: ${destPath}`);
  return destPath;
}

// ======================
// CSV Parsing
// ======================
async function parseCSV(content) {
  log('🔧 Converting CSV rows into in‑memory product objects');
  return new Promise((resolve, reject) => {
    const rows = [];
    const parser = csvParser({
      separator: ';',
      mapHeaders: ({ header }) => header.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      mapValues: ({ value }) => (typeof value === 'string' ? value.trim().replace(/^"|"$/g, '') : value)
    });
    parser.on('data', data => rows.push(data));
    parser.on('end', () => {
      log(`📊 Parsed ${rows.length} rows of product data into memory`);
      resolve(rows);
    });
    parser.on('error', reject);
    const cleaned = content.split('\n').map(l => l.replace(/^"|"$/g, '')).join('\n');
    parser.write(cleaned);
    parser.end();
  });
}

// ======================
// Invoice Generation
// ======================
async function generateInvoice(products) {
  log('🖨️  Filling Excel template with product data and customer name');
  const templatePath = `${CONFIG.DROPBOX.FOLDERS.TEMPLATE}/Invoice-template.xlsx`;
  const templateBuffer = await downloadBinaryFile(templatePath);
  const workbook = XLSX.read(templateBuffer, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];

  const rawName = products[0].fileName;
  const baseName = rawName.replace(/\.csv$/, '');
  log(`✍️  Writing customer name "${baseName}" into cell B5`);
  XLSX.utils.sheet_add_aoa(worksheet, [[baseName]], { origin: 'B5' });

  products.forEach((p, idx) => {
    const rowNum = 13 + idx;
    XLSX.utils.sheet_add_aoa(worksheet, [[p.productId, p.style, p.productName, null, p.amount, p.rrp]], { origin: `A${rowNum}` });
  });
  log('🖊️  All product lines copied into the spreadsheet');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const invoiceName = `${baseName}_${timestamp}.xlsx`;
  const invoicePath = `${CONFIG.DROPBOX.FOLDERS.INVOICE_OUTPUT}/${invoiceName}`;
  log(`💾 Saving invoice as: ${invoiceName}`);

  const outBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  await uploadBufferToDropbox(outBuffer, invoicePath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

// ======================
// Webhook Handler
// ======================
const app = express();
app.use(express.json({ verify: (req, _, buf) => { req.raw = buf.toString(); } }));

app.post('/webhook', async (req, res) => {
  log('📥 Dropbox webhook received: new file detected');
  try {
    log('🔒 Validating webhook signature (HMAC‑SHA256)');
    const signature = req.header('x-dropbox-signature');
    const expected = crypto.createHmac('sha256', CONFIG.DROPBOX.APP_SECRET).update(req.raw).digest('hex');
    if (signature !== expected) {
      log('❌ Signature mismatch – request rejected');
      return res.status(403).send('Unauthorized');
    }
    log('✅ Webhook signature valid – request is authentic');

    log('⏳ Waiting 2 s to allow Dropbox to finish writing the file');
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY_MS));

    log(`📂 Scanning folder for newest CSV: ${CONFIG.DROPBOX.FOLDERS.INPUT_CSV}`);
    const listRes = await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (err, result) => err ? reject(err) : resolve(result));
    });

    const csvFiles = listRes.entries.filter(e => e['.tag'] === 'file' && e.name.endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (!csvFiles.length) {
      log('ℹ️  No CSV files found – nothing to process');
      return res.status(200).send('No files');
    }

    const latest = csvFiles[0];
    log(`📌 Latest CSV selected: ${latest.name}`);

    const csvContent = await downloadTextFile(latest.path_display);
    const records = await parseCSV(csvContent);

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

    await moveDropboxFile(latest.path_display, CONFIG.DROPBOX.FOLDERS.PROCESSED_CSV);

    if (products.length) {
      await generateInvoice(products);
    }

    log('🎉 Automation pipeline complete – response returned to Dropbox');
    res.status(200).send('OK');
  } catch (error) {
    console.error('🔥 Error in automation pipeline:', error);
    res.status(500).send('Internal error');
  }
});

// ======================
// Server Startup
// ======================
(async function start() {
  try {
    if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) throw new Error('Dropbox credentials missing');
    await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (err, res) => err ? reject(err) : resolve(res));
    });
    app.listen(CONFIG.SERVER_PORT, () => {
      log('🚀 Container started – server online');
      log(`🔈 Listening on port ${CONFIG.SERVER_PORT}`);
      log('🗂️  Configured Dropbox folders:');
      Object.entries(CONFIG.DROPBOX.FOLDERS).forEach(([key, val]) => log(`   • ${key} → ${val}`));
    });
  } catch (err) {
    console.error('💥 Startup failed:', err.message);
    process.exit(1);
  }
})();
