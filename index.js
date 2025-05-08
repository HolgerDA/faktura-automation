// ======================
// Environment Setup
// ======================
require('dotenv').config();
const express  = require('express');
const Dropbox  = require('dropbox-v2-api');
const crypto   = require('crypto');
const csv      = require('csv-parser');
const axios    = require('axios');
const path     = require('path');
const XLSX     = require('xlsx');      // New
const stream   = require('stream');    // New
const app      = express();

// ======================
// Configuration Constants
// ======================
const CONFIG = {
  SERVER_PORT: process.env.PORT || 8080,
  DROPBOX: {
    TOKEN:           process.env.DROPBOX_TOKEN,
    APP_SECRET:      process.env.DROPBOX_APP_SECRET,
    INPUT_FOLDER:    process.env.DROPBOX_INPUT_FOLDER    || '/csv-files',
    PROCESSED_FOLDER:process.env.DROPBOX_PROCESSED_FOLDER|| '/processed-csv-files'
  },
  SECURITY: {
    WEBHOOK_DELAY: 2000 // 2-second processing delay
  }
};

// ======================
// Dropbox Client Setup
// ======================
const dropbox = Dropbox.authenticate({ token: CONFIG.DROPBOX.TOKEN });

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
 * Download a CSV file from Dropbox and return its raw text.
 */
async function downloadCSVFile(filePath) {
  console.log(`⏬ Starting download of CSV file: ${filePath}`);
  return new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) return reject(err);
      axios.get(result.link)
        .then(response => {
          console.log(`✅ CSV file downloaded: ${filePath}`);
          resolve(response.data);
        })
        .catch(reject);
    });
  });
}

/**
 * Move a processed CSV to the archive folder with a timestamped name.
 */
async function archiveProcessedFile(sourcePath) {
  console.log(`📦 Archiving CSV file: ${sourcePath}`);
  return new Promise((resolve, reject) => {
    const originalName   = path.basename(sourcePath);
    const timestamp      = Date.now();
    const destinationPath= `${CONFIG.DROPBOX.PROCESSED_FOLDER}/${originalName}_${timestamp}.csv`;

    dropbox({
      resource: 'files/move_v2',
      parameters: {
        from_path: sourcePath,
        to_path:   destinationPath,
        autorename: false
      }
    }, (err, result) => {
      if (err) return reject(err);
      console.log(`✅ CSV file archived to: ${destinationPath}`);
      resolve(result);
    });
  });
}

/**
 * Download any file from Dropbox as a Buffer.
 */
async function downloadFile(filePath) {
  console.log(`⏬ Downloading file: ${filePath}`);
  return new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) return reject(err);
      axios.get(result.link, { responseType: 'arraybuffer' })
        .then(response => {
          console.log(`✅ File downloaded: ${filePath}`);
          resolve(Buffer.from(response.data));
        })
        .catch(reject);
    });
  });
}

/**
 * Generate an Excel invoice from product data and upload it.
 */
async function generateInvoiceFile(products) {
  try {
    console.log('📝 Generating invoice …');
    const templateBuffer = await downloadFile('/template/Invoice-template.xlsx');

    const workbook  = XLSX.read(templateBuffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    console.log('✅ Invoice template loaded');

    // Base name without .csv
    const baseName = products[0].fileName.replace(/\.csv$/i, '');

    // Insert customer / base name in cell B5
    XLSX.utils.sheet_add_aoa(worksheet, [[baseName]], { origin: 'B5' });

    // Insert product rows (start at row 13)
    products.forEach((p, idx) => {
      const row = 13 + idx;
      XLSX.utils.sheet_add_aoa(worksheet, [[
        p.productId,
        p.style,
        p.productName,
        null,
        p.amount,
        p.rrp
      ]], { origin: `A${row}` });
    });
    console.log(`✅ Populated invoice worksheet with ${products.length} products`);

    // Create buffer of filled workbook
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Filename with ISO timestamp
    const iso           = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName      = `${baseName}_${iso}.xlsx`;
    const destination   = `/Teamsport-Invoice/${fileName}`;

    // Upload invoice
    await new Promise((resolve, reject) => {
      const uploadStream = dropbox({
        resource: 'files/upload',
        parameters: {
          path: destination,
          mode: 'overwrite',
          autorename: false
        },
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
      }, (err, result) => err ? reject(err) : resolve(result));

      const bufferStream = new stream.PassThrough();
      bufferStream.end(excelBuffer);
      bufferStream.pipe(uploadStream);
    });

    console.log(`✅ Invoice uploaded to: ${destination}`);
  } catch (error) {
    console.error('❌ Error while generating invoice:', error);
    throw error;
  }
}

// ======================
// CSV Processing Helpers
// ======================

/**
 * Parse raw CSV text into clean JS objects.
 */
function parseCSVContent(csvData) {
  console.log('🔍 Parsing CSV content …');
  return new Promise((resolve, reject) => {
    const results = [];
    const parser  = csv({
      separator: ';',
      mapHeaders: ({ header }) =>
        header.trim()
              .replace(/["\\]/g, '')        // remove quotes & backslashes
              .replace(/\s+/g, '_')          // spaces → underscore
              .replace(/[^a-zA-Z0-9_]/g, '') // alphanumerics & underscore only
              .toLowerCase(),
      mapValues: ({ value }) =>
        typeof value === 'string'
          ? value.replace(/^"|"$/g, '').trim()
          : value
    });

    parser.on('data', data => results.push(data))
          .on('end', () => {
            console.log(`✅ CSV parsed – ${results.length} rows`);
            resolve(results);
          })
          .on('error', reject);

    // Strip outer quotes line-by-line
    const cleanedCsv = csvData.split('\n')
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
  try {
    // 1️⃣ Validate Dropbox HMAC signature
    const signature         = req.header('x-dropbox-signature');
    const expectedSignature = crypto.createHmac('sha256', CONFIG.DROPBOX.APP_SECRET)
                                    .update(req.rawBody)
                                    .digest('hex');

    if (signature !== expectedSignature) {
      console.warn('⚠️  Invalid webhook signature – request rejected');
      return res.status(403).send('Unauthorized');
    }
    console.log('✅ Webhook signature validated');

    // 2️⃣ Wait a moment so Dropbox has finished writing the new file(s)
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY));
    console.log('⏳ Delay complete – checking for new CSV files');

    // 3️⃣ List recent files in the input folder
    const folderContents = await new Promise((resolve, reject) => {
      dropbox({
        resource:   'files/list_folder',
        parameters: { path: CONFIG.DROPBOX.INPUT_FOLDER, limit: 10 }
      }, (err, result) => err ? reject(err) : resolve(result));
    });
    console.log('✅ Folder listing retrieved');

    const csvFiles = folderContents.entries
      .filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (csvFiles.length === 0) {
      console.log('ℹ️  No CSV files to process');
      return res.status(200).send('No files to process');
    }

    // 4️⃣ Download the newest CSV file
    const targetFile  = csvFiles[0];
    const csvContent  = await downloadCSVFile(targetFile.path_display);

    // 5️⃣ Parse CSV → objects
    const parsedData  = await parseCSVContent(csvContent);

    // 6️⃣ Transform into internal product representation
    const products = parsedData.map(item => {
      const parseNumber = str => {
        const cleaned = str.replace(/[^0-9,]/g, '').replace(',', '.');
        return cleaned ? parseFloat(cleaned) : 0;
      };

      return {
        fileName:         targetFile.name,
        productId:        item.product_id,
        style:            item.style,
        productName:      item.name,
        size:             item.size,
        amount:           parseInt(item.amount, 10) || 0,
        locations:        item.locations.split('-').map(l => l.trim()),
        purchasePriceDKK: parseNumber(item.purchase_price_dkk),
        rrp:              parseNumber(item.rrp),
        tariffCode:       item.tariff_code,
        countryOfOrigin:  item.country_of_origin
      };
    });
    console.log(`✅ Data transformed – ${products.length} products`);

    // 7️⃣ Generate and upload Excel invoice
    if (products.length > 0) {
      await generateInvoiceFile(products);
      console.log('✅ Invoice generation completed');
    } else {
      console.log('ℹ️  No products – invoice skipped');
    }

    // 8️⃣ Archive the processed CSV
    await archiveProcessedFile(targetFile.path_display);

    console.log('🎉 Webhook processing finished successfully');
    res.status(200).send('Processing complete');
  } catch (error) {
    console.error('❌ Processing error:', error);
    res.status(500).send('Internal server error');
  }
});

// ======================
// Server Initialization
// ======================
async function initializeServer() {
  // Validate required env vars
  if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) {
    throw new Error('Missing required Dropbox environment variables');
  }

  // Verify Dropbox connection
  try {
    await new Promise((resolve, reject) => {
      dropbox({
        resource:   'files/list_folder',
        parameters: { path: CONFIG.DROPBOX.INPUT_FOLDER }
      }, (err, res) => err ? reject(err) : resolve(res));
    });
    console.log('✅ Connected to Dropbox');
  } catch (error) {
    throw new Error(`Dropbox connection failed: ${error.message}`);
  }

  // Start the HTTP server
  app.listen(CONFIG.SERVER_PORT, () => {
    console.log(`🚀 Server running on port ${CONFIG.SERVER_PORT}`);
    console.log('📂 Configured folders:');
    console.log(`   • Input:   ${CONFIG.DROPBOX.INPUT_FOLDER}`);
    console.log(`   • Archive: ${CONFIG.DROPBOX.PROCESSED_FOLDER}`);
  });
}

// Bootstrap application
initializeServer().catch(error => {
  console.error('❌ Server initialization failed:', error.message);
  process.exit(1);
});
