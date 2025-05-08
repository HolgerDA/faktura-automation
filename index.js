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
  const res = await new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: dropboxPath }
    }, (err, result) => err ? reject(err) : resolve(result));
  });
  return res.link;
}

async function downloadTextFile(dropboxPath) {
  log(`Downloading text file: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  const response = await axios.get(link);
  log(`Download complete: ${dropboxPath}`);
  return response.data;
}

async function downloadBinaryFile(dropboxPath) {
  log(`Downloading binary file: ${dropboxPath}`);
  const link = await getTemporaryLink(dropboxPath);
  const response = await axios.get(link, { responseType: 'arraybuffer' });
  log(`Download complete: ${dropboxPath}`);
  return Buffer.from(response.data);
}

async function uploadBufferToDropbox(buffer, destinationPath, mimeType) {
  log(`Uploading file to: ${destinationPath}`);
  await new Promise((resolve, reject) => {
    const upload = dropbox({
      resource: 'files/upload',
      parameters: {
        path: destinationPath,
        mode: 'overwrite',
        autorename: false
      },
      headers: { 'Content-Type': mimeType }
    }, (err, result) => err ? reject(err) : resolve(result));

    const pass = new stream.PassThrough();
    pass.end(buffer);
    pass.pipe(upload);
  });
  log(`Upload successful: ${destinationPath}`);
}

async function moveDropboxFile(sourcePath, targetFolder) {
  const base = path.basename(sourcePath);
  const timestamp = Date.now();
  const destPath = `${targetFolder}/${base}_${timestamp}.csv`;
  log(`Moving file to archive: ${destPath}`);
  await new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/move_v2',
      parameters: { from_path: sourcePath, to_path: destPath, autorename: false }
    }, (err, result) => err ? reject(err) : resolve(result));
  });
  log(`Archive complete: ${destPath}`);
}

// ======================
// CSV Parsing
// ======================
async function parseCSV(content) {
  log('Parsing CSV content');
  return new Promise((resolve, reject) => {
    const items = [];
    const parser = csvParser({
      separator: ';',
      mapHeaders: ({ header }) => header.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      mapValues: ({ value }) => typeof value === 'string' ? value.trim().replace(/^"|"$/g, '') : value
    });

    parser.on('data', row => items.push(row));
    parser.on('end', () => {
      log('CSV parsing finished');
      resolve(items);
    });
    parser.on('error', reject);

    // Clean quotes
    const cleaned = content.split('\n').map(l => l.replace(/^"|"$/g, '')).join('\n');
    parser.write(cleaned);
    parser.end();
  });
}

// ======================
// Invoice Generation
// ======================
async function generateInvoice(products) {
  log('Generating invoice file');
  const templatePath = `${CONFIG.DROPBOX.FOLDERS.TEMPLATE}/Invoice-template.xlsx`;
  const templateBuf = await downloadBinaryFile(templatePath);

  log('Loaded invoice template');
  const wb = XLSX.read(templateBuf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Insert filename
  const baseName = products[0].fileName.replace(/\.csv$/, '');
  XLSX.utils.sheet_add_aoa(ws, [[baseName]], { origin: 'B5' });

  // Insert product rows
  products.forEach((p, i) => {
    const row = 13 + i;
    XLSX.utils.sheet_add_aoa(ws, [[p.productId, p.style, p.productName, null, p.amount, p.rrp]], { origin: `A${row}` });
  });
  log('Populated invoice data');

  const outBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${baseName}_${isoStamp}.xlsx`;
  const outPath = `${CONFIG.DROPBOX.FOLDERS.INVOICE_OUTPUT}/${fileName}`;

  await uploadBufferToDropbox(outBuf, outPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  log(`Invoice created: ${outPath}`);
}

// ======================
// Webhook Handler
// ======================
const app = express();
app.use(express.json({ verify: (req, _, buf) => { req.raw = buf.toString(); } }));

app.post('/webhook', async (req, res) => {
  log('=== New webhook received ===');

  try {
    // Signature
    log('Validating webhook signature');
    const sig = req.header('x-dropbox-signature');
    const expected = crypto.createHmac('sha256', CONFIG.DROPBOX.APP_SECRET).update(req.raw).digest('hex');
    if (sig !== expected) {
      log('Signature validation failed');
      return res.status(403).send('Unauthorized');
    }
    log('Webhook signature valid');

    // Delay
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY_MS));
    log('Security delay complete');

    // List CSV files
    log(`Listing files in: ${CONFIG.DROPBOX.FOLDERS.INPUT_CSV}`);
    const list = await new Promise((res, rej) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (e, r) => e ? rej(e) : res(r)
      );
    });

    const csvs = list.entries.filter(e => e['.tag']==='file' && e.name.endsWith('.csv'))
      .sort((a,b)=>new Date(b.server_modified)-new Date(a.server_modified));

    if (!csvs.length) {
      log('No CSV to process');
      return res.status(200).send('No files');
    }

    const latest = csvs[0];
    log(`Processing file: ${latest.name}`);
    const content = await downloadTextFile(latest.path_display);
    const records = await parseCSV(content);

    // Transform records
    log('Transforming records');
    const products = records.map(r => ({
      fileName: latest.name,
      productId: r.product_id,
      style: r.style,
      productName: r.name,
      size: r.size,
      amount: parseInt(r.amount,10)||0,
      locations: r.locations.split('-').map(x=>x.trim()),
      purchasePriceDKK: parseFloat(r.purchase_price_dkk.replace(',','.'))||0,
      rrp: parseFloat(r.rrp.replace(',','.'))||0,
      tariffCode: r.tariff_code,
      countryOfOrigin: r.country_of_origin
    }));
    log('Data transformation complete');

    // Invoice
    if (products.length) {
      await generateInvoice(products);
    }

    // Archive
    await moveDropboxFile(latest.path_display, CONFIG.DROPBOX.FOLDERS.PROCESSED_CSV);

    log('=== Processing complete ===');
    res.status(200).send('OK');

  } catch (err) {
    console.error('Error in webhook handler:', err);
    res.status(500).send('Error');
  }
});

// ======================
// Server Startup
// ======================
(async function startServer() {
  try {
    if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) throw new Error('Missing Dropbox credentials');
    // Test connection
    await new Promise((res, rej) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.FOLDERS.INPUT_CSV } },
        (e, r) => e ? rej(e) : res(r)
      );
    });
    app.listen(CONFIG.SERVER_PORT, () => {
      log(`Server running on port ${CONFIG.SERVER_PORT}`);
      log('Configured Dropbox folders:');
      Object.entries(CONFIG.DROPBOX.FOLDERS).forEach(([k,v]) => log(`- ${k}: ${v}`));
    });
  } catch (e) {
    console.error('Startup error:', e.message);
    process.exit(1);
  }
})();
