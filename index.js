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
 * Downloads any file from Dropbox as Buffer
 * @param {string} filePath - Full Dropbox path to file
 */
async function downloadFile(filePath) {
  return new Promise((resolve, reject) => {
    dropbox({
      resource: 'files/get_temporary_link',
      parameters: { path: filePath }
    }, (err, result) => {
      if (err) return reject(err);
      axios.get(result.link, { responseType: 'arraybuffer' })
        .then(response => resolve(Buffer.from(response.data)))
        .catch(reject);
    });
  });
}

/**
 * Downloads CSV file from Dropbox
 * @param {string} filePath - Full Dropbox path to CSV file
 */
async function downloadCSVFile(filePath) {
  // Use downloadFile to get CSV buffer then convert to text
  const buffer = await downloadFile(filePath);
  return buffer.toString('utf-8');
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
// Excel Processing (new)
// ======================
async function generateInvoiceFile(products) {
  try {
    // 1. Hent template fra Dropbox
    const templateBuffer = await downloadFile('/template/test.xlsx');
    const workbook = XLSX.read(templateBuffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // 2. Indsæt filnavn (uden .csv) i celle B5
    const baseName = products[0].fileName.replace(/\.csv$/, '');
    XLSX.utils.sheet_add_aoa(worksheet, [[baseName]], { origin: 'B5' });

    // 3. Udskriv produktdata til Excel fra række 13 og nedad
    products.forEach((product, index) => {
      const row = 13 + index;
      XLSX.utils.sheet_add_aoa(worksheet, [
        [
          product.productId,
          product.style,
          product.productName,
          null, // Kolonne D springes over
          product.amount,
          product.rrp
        ]
      ], { origin: `A${row}` });
    });

    // 4. Konverter til buffer
    const excelBuffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx'
    });

    // 5. Opret filnavn med timestamp og uploadsti
    const timestamp = Date.now();
    const fileName = `${baseName}_${timestamp}.xlsx`;
    const destinationPath = `/Teamsport-Invoice/${fileName}`;

    // 6. Upload til Dropbox via stream
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
        if (err) reject(err);
        else resolve(result);
      });

      const bufferStream = new stream.PassThrough();
      bufferStream.end(excelBuffer);
      bufferStream.pipe(uploadStream);
    });

    console.log(`Fakturafil oprettet: ${destinationPath}`);
  } catch (error) {
    console.error('Fejl under generering af fakturafil:', error);
    throw error;
  }
});
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // 2. Udskriv data til Excel
    products.forEach((product, index) => {
      const row = 13 + index;
      XLSX.utils.sheet_add_aoa(worksheet, [
        [
          product.productId,
          product.style,
          product.productName,
          null, // Kolonne D springes over
          product.amount,
          product.rrp
        ]
      ], { origin: `A${row}` });
    });

    // 3. Konverter til buffer
    const excelBuffer = XLSX.write(workbook, { 
      type: 'buffer', 
      bookType: 'xlsx' 
    });

    // 4. Upload til Dropbox
    const fileName = products[0].fileName.replace(/\.csv$/, '.xlsx');
    const destinationPath = `/Teamsport-Invoice/${fileName}`;

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
        if (err) reject(err);
        else resolve(result);
      });

      const bufferStream = new stream.PassThrough();
      bufferStream.end(excelBuffer);
      bufferStream.pipe(uploadStream);
    });

    console.log(`Fakturafil oprettet: ${destinationPath}`);

  } catch (error) {
    console.error('Fejl under generering af fakturafil:', error);
    throw error;
  }
}

// ======================
// CSV Processing
// ======================
function parseCSVContent(csvData) {
  return new Promise((resolve, reject) => {
    const results = [];
    const parser = csv({
      separator: ';',
      mapHeaders: ({ header }) => header.trim()
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
      .on('end', () => resolve(results))
      .on('error', reject);

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

    // Delay for Dropbox processing
    await new Promise(r => setTimeout(r, CONFIG.SECURITY.WEBHOOK_DELAY));

    // List recent CSV files
    const folderContents = await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.INPUT_FOLDER, limit: 10 } },
        (err, result) => err ? reject(err) : resolve(result)
      );
    });

    const csvFiles = folderContents.entries
      .filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith('.csv'))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));

    if (!csvFiles.length) {
      return res.status(200).send('No files to process');
    }

    const targetFile = csvFiles[0];
    const csvContent = await downloadCSVFile(targetFile.path_display);
    const parsedData = await parseCSVContent(csvContent);

    // Transform data
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
       .countryOfOrigin: item.country_of_origin
      };
    });

    console.log('Processerede produkter:', JSON.stringify(products, null, 2));

    // NY FUNKTIONALITET: Generer fakturafil
    if (products.length > 0) {
      await generateInvoiceFile(products);
    }

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
  if (!CONFIG.DROPBOX.TOKEN || !CONFIG.DROPBOX.APP_SECRET) {
    throw new Error('Missing required Dropbox environment variables');
  }

  // Verify Dropbox connection
  try {
    await new Promise((resolve, reject) => {
      dropbox({ resource: 'files/list_folder', parameters: { path: CONFIG.DROPBOX.INPUT_FOLDER } }, (err, res) => err ? reject(err) : resolve(res));
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

initializeServer().catch(error => {
  console.error('Server initialization failed:', error.message);
  process.exit(1);
});
