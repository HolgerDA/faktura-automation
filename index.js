'use strict';

/* -------------------------------------------------------------------------- */
/*                               1.  DEPENDENCIES                              */
/* -------------------------------------------------------------------------- */
require('dotenv').config();
const express  = require('express');
const Dropbox  = require('dropbox-v2-api');
const crypto   = require('crypto');
const csv      = require('csv-parser');
const axios    = require('axios');
const path     = require('path');
const XLSX     = require('xlsx');
const stream   = require('stream');

const app = express();

/* -------------------------------------------------------------------------- */
/*                               2.  CONFIGURATION                            */
/* -------------------------------------------------------------------------- */
const CONFIG = {
  SERVER_PORT : process.env.PORT || 8080,
  DROPBOX     : {
    TOKEN            : process.env.DROPBOX_TOKEN,
    APP_SECRET       : process.env.DROPBOX_APP_SECRET,

    // -- Folder paths (⇣⇣⇣ keep these in sync with Dropbox) -----------------
    INPUT_FOLDER     : process.env.DROPBOX_INPUT_FOLDER     || '/csv-filer',
    PROCESSED_FOLDER : process.env.DROPBOX_PROCESSED_FOLDER || '/processed-csv-files',
    TEMPLATE_FOLDER  : process.env.DROPBOX_TEMPLATE_FOLDER  || '/template',
    INVOICE_FOLDER   : process.env.DROPBOX_INVOICE_FOLDER   || '/Teamsport-Invoice'
  },
  SECURITY : {
    WEBHOOK_DELAY_MS : 2_000            //  2-second write-settle delay
  }
};

/* -------------------------------------------------------------------------- */
/*                            3.  DROPBOX INITIALISATION                      */
/* -------------------------------------------------------------------------- */
const dropbox = Dropbox.authenticate({ token : CONFIG.DROPBOX.TOKEN });

/* -------------------------------------------------------------------------- */
/*                              4.  HELPER FUNCTIONS                          */
/* -------------------------------------------------------------------------- */

// generic, promise-based delay
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// obtain a Dropbox temporary link for any path
const getTempLink = (dbxPath) => new Promise((resolve, reject) => {
  dropbox({
    resource   : 'files/get_temporary_link',
    parameters : { path : dbxPath }
  }, (err, res) => (err ? reject(err) : resolve(res.link)));
});

// download text (CSV) via the temp link
const downloadTextFile = async (dbxPath) => {
  console.log('Fetching CSV file via API link …');
  const link = await getTempLink(dbxPath);
  console.log('Temporary download link obtained');
  const { data } = await axios.get(link);
  console.log('CSV content successfully downloaded');
  return data;
};

// download binary (template) via the temp link
const downloadBinaryFile = async (dbxPath) => {
  console.log('Temporary download link for template obtained');
  const link = await getTempLink(dbxPath);
  const { data } = await axios.get(link, { responseType : 'arraybuffer' });
  console.log('Template file downloaded');
  return Buffer.from(data);
};

// move file to another Dropbox folder, appending timestamp
const moveFileWithTimestamp = (fromPath, toFolder) => new Promise((resolve, reject) => {
  const name      = path.basename(fromPath);
  const timestamp = Date.now();
  const toPath    = `${toFolder}/${name}_${timestamp}.csv`;

  dropbox({
    resource   : 'files/move_v2',
    parameters : { from_path : fromPath, to_path : toPath, autorename : false }
  }, (err, res) => (err ? reject(err) : resolve(toPath)));
});

// upload binary buffer to Dropbox
const uploadFile = (buffer, dbxPath, mimeType) => new Promise((resolve, reject) => {
  const uploadStream = dropbox({
    resource   : 'files/upload',
    parameters : { path : dbxPath, mode : 'overwrite', autorename : false },
    headers    : { 'Content-Type' : mimeType }
  }, (err, res) => (err ? reject(err) : resolve(res)));

  const pass = new stream.PassThrough();
  pass.end(buffer);
  pass.pipe(uploadStream);
});

/* -------------------------------------------------------------------------- */
/*                          5.  CSV  &  INVOICE SERVICES                      */
/* -------------------------------------------------------------------------- */

/* ----- 5.1  CSV parsing --------------------------------------------------- */
const parseCSV = (rawCsv) => new Promise((resolve, reject) => {
  console.log('🔧 Converting CSV rows into in-memory product objects');

  const rows = [];
  const parser = csv({
    separator  : ';',
    mapHeaders : ({ header }) => header
      .trim().replace(/["\\]/g, '')
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toLowerCase(),
    mapValues  : ({ value }) => typeof value === 'string'
      ? value.replace(/^"|"$/g, '').trim()
      : value
  });

  parser.on('data', (d) => rows.push(d))
        .on('error', reject)
        .on('end', () => {
          console.log(`Parsed ${rows.length} product rows`);
          resolve(rows);
        });

  // remove outer quotes on each line first
  const cleaned = rawCsv.split('\n')
                        .map(l => l.trim().replace(/^"|"$/g, ''))
                        .join('\n');

  parser.write(cleaned);
  parser.end();
});

/* ----- 5.2  Invoice generation ------------------------------------------- */
const generateInvoice = async (products) => {
  console.log('Fetching latest invoice template from /template');
  const templatePath = `${CONFIG.DROPBOX.TEMPLATE_FOLDER}/Invoice-template.xlsx`;
  const templateBuf  = await downloadBinaryFile(templatePath);

  const workbook   = XLSX.read(templateBuf, { type : 'buffer' });
  const sheet      = workbook.Sheets[workbook.SheetNames[0]];
  const baseName   = products[0].fileName.replace(/\.csv$/i, '');

  console.log('Writing customer name into cell B5');
  XLSX.utils.sheet_add_aoa(sheet, [[ baseName ]], { origin : 'B5' });

  console.log('All product lines copied into spreadsheet');
  products.forEach((p, idx) => {
    const row = 13 + idx;
    XLSX.utils.sheet_add_aoa(
      sheet,
      [[ p.productId, p.style, p.productName, null, p.amount, p.rrp ]],
      { origin : `A${row}` }
    );
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outName   = `${baseName}_${timestamp}.xlsx`;
  const outPath   = `${CONFIG.DROPBOX.INVOICE_FOLDER}/${outName}`;

  console.log(`Saving invoice as ${outName}`);
  const buf = XLSX.write(workbook, { type : 'buffer', bookType : 'xlsx' });

  console.log('Uploading finished invoice so Finance can access it');
  await uploadFile(buf, outPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  console.log('Invoice upload complete');
};

/* -------------------------------------------------------------------------- */
/*                           6.  EXPRESS  MIDDLEWARE                          */
/* -------------------------------------------------------------------------- */
app.use(express.json({
  verify : (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

/* -------------------------------------------------------------------------- */
/*                                7.  WEBHOOK                                 */
/* -------------------------------------------------------------------------- */
app.post('/webhook', async (req, res) => {
  console.log('Dropbox webhook received');

  try {
    /* --- 7.1  Signature check ------------------------------------------- */
    console.log('Validating webhook signature');
    const sig = req.header('x-dropbox-signature');
    const expected = crypto.createHmac('sha256', CONFIG.DROPBOX.APP_SECRET)
                           .update(req.rawBody).digest('hex');

    if (sig !== expected) {
      console.error('Invalid webhook signature – request blocked');
      return res.status(403).send('Unauthorized');
    }
    console.log('Webhook signature valid');

    /* --- 7.2  Wait for Dropbox to finish writing ------------------------ */
    console.log(`Waiting ${CONFIG.SECURITY.WEBHOOK_DELAY_MS / 1000} s so Dropbox can finish writing`);
    await delay(CONFIG.SECURITY.WEBHOOK_DELAY_MS);

    /* --- 7.3  Identify newest CSV -------------------------------------- */
    console.log('Scanning folder for newest CSV');
    const { entries } = await new Promise((resolve, reject) => {
      dropbox({
        resource   : 'files/list_folder',
        parameters : { path : CONFIG.DROPBOX.INPUT_FOLDER, limit : 20 }
      }, (err, res2) => (err ? reject(err) : resolve(res2)));
    });

    const csvFiles = entries
      .filter(e => e['.tag'] === 'file' && e.name.toLowerCase().endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (!csvFiles.length) {
      console.log('No CSV files found – nothing to process');
      return res.status(200).send('No CSV files to process');
    }

    const latest = csvFiles[0];
    console.log(`Latest CSV selected – ${latest.name}`);

    /* --- 7.4  Download + parse CSV ------------------------------------- */
    const csvData   = await downloadTextFile(latest.path_display);
    const csvRows   = await parseCSV(csvData);

    const num = str => {
      const cleaned = str.replace(/[^0-9,]/g, '').replace(',', '.');
      return cleaned ? parseFloat(cleaned) : 0;
    };

    const products = csvRows.map(r => ({
      fileName         : latest.name,
      productId        : r.product_id,
      style            : r.style,
      productName      : r.name,
      size             : r.size,
      amount           : parseInt(r.amount, 10) || 0,
      locations        : r.locations.split('-').map(l => l.trim()),
      purchasePriceDKK : num(r.purchase_price_dkk),
      rrp              : num(r.rrp),
      tariffCode       : r.tariff_code,
      countryOfOrigin  : r.country_of_origin
    }));

    /* --- 7.5  Build & upload invoice ----------------------------------- */
    if (products.length) {
      await generateInvoice(products);
    }

    /* --- 7.6  Archive the original CSV --------------------------------- */
    console.log('Archiving original CSV & appending timestamp');
    const archivedPath = await moveFileWithTimestamp(
      latest.path_display,
      CONFIG.DROPBOX.PROCESSED_FOLDER
    );
    console.log(`CSV moved to ${archivedPath}`);

    /* --- 7.7  Respond OK ------------------------------------------------ */
    console.log('Automation pipeline complete');
    return res.status(200).send('Processing complete');

  } catch (err) {
    console.error('Processing error:', err);
    return res.status(500).send('Internal server error');
  }
});

/* -------------------------------------------------------------------------- */
/*                           8.  SERVER  INITIALISATION                       */
/* -------------------------------------------------------------------------- */
(async () => {
  try {
    if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) {
      throw new Error('Missing required Dropbox environment variables');
    }

    // quick sanity-check that the INPUT_FOLDER exists
    await new Promise((resolve, reject) => {
      dropbox({
        resource   : 'files/list_folder',
        parameters : { path : CONFIG.DROPBOX.INPUT_FOLDER, limit : 1 }
      }, (err) => (err ? reject(err) : resolve()));
    });

    app.listen(CONFIG.SERVER_PORT, () => {
      console.log(`Server online →  http://localhost:${CONFIG.SERVER_PORT}`);
      console.table({
        'INPUT_FOLDER'    : CONFIG.DROPBOX.INPUT_FOLDER,
        'PROCESSED_FOLDER': CONFIG.DROPBOX.PROCESSED_FOLDER,
        'TEMPLATE_FOLDER' : CONFIG.DROPBOX.TEMPLATE_FOLDER,
        'INVOICE_FOLDER'  : CONFIG.DROPBOX.INVOICE_FOLDER
      });
    });

  } catch (err) {
    console.error('Server failed to start:', err.message);
    process.exit(1);
  }
})();
