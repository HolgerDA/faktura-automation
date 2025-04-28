require('dotenv').config();
const express = require('express');
const app = express();
const Dropbox = require('dropbox-v2-api');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// ========== KRITISK OPSÆTNING ==========
app.use(express.json()); // Tillad JSON-parsing af requests
const dropbox = Dropbox.authenticate({
    token: process.env.DROPBOX_TOKEN
});

// ========== WEBHOOK HANDLERS ==========
// Validerings-endpoint (GET)
app.get('/webhook', (req, res) => {
    console.log('Modtog Dropbox valideringsrequest');
    const challenge = req.query.challenge;
    if (!challenge) {
        return res.status(400).send('Mangler challenge parameter');
    }
    res.type('text/plain').send(challenge);
});

// Hoved-webhook (POST)
app.post('/webhook', async (req, res) => {
    try {
        console.log('Modtog Dropbox notifikation');
        
        // 1. Valider signaturen
        const signature = req.header('x-dropbox-signature');
        const isValid = dropbox.webhook.verify(
            process.env.DROPBOX_APP_SECRET,
            JSON.stringify(req.body),
            signature
        );

        if (!isValid) {
            console.log('Ugyldig signatur - muligt hackforsøg');
            return res.status(403).send('Invalid signature');
        }

        // 2. Processer hver filændring
        for (const entry of req.body.list_folder.entries) {
            if (entry['.tag'] === 'file' && entry.path_lower.endsWith('.csv')) {
                console.log('Ny CSV fil fundet:', entry.path_lower);
                
                // HER KOMMER DIN CSV-PROCESSERING LOGIK SENERE
                // Eksempel: processCSV(entry.path_lower);
            }
        }

        res.status(200).send('Notifikation modtaget');
    } catch (error) {
        console.error('Webhook fejl:', error);
        res.status(500).send('Serverfejl');
    }
});

// ========== TEST ENDPOINT ==========
app.get('/test', async (req, res) => {
    try {
        const testValue = "TEST123";
        
        // 1. Download skabelon fra Dropbox
        const templatePath = '/FakturaSkabelon/FakturaSkabelon.xlsx';
        const {file} = await dropbox({
            resource: 'files/download',
            parameters: { path: templatePath }
        }, (err, result, response) => {}).promise();
        // 2. Modificer Excel-filen
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(file);
        
        const worksheet = workbook.getWorksheet(1);
        worksheet.getCell('A1').value = testValue;
        // 3. Gem midlertidig fil
        const tempFilePath = path.join(__dirname, 'temp.xlsx');
        await workbook.xlsx.writeFile(tempFilePath);
        // 4. Upload til Dropbox
        const destinationPath = `/FakturaOutput/Faktura_${testValue}.xlsx`;
        await dropbox({
            resource: 'files/upload',
            parameters: {
                path: destinationPath,
                mode: 'overwrite'
            },
            readStream: fs.createReadStream(tempFilePath)
        }, (err, result, response) => {}).promise();
        // Ryd op
        fs.unlinkSync(tempFilePath);
        res.send('Faktura genereret succesfuldt!');
    } catch (error) {
        console.error('Fejl:', error);
        res.status(500).send('Der opstod en fejl');
    }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server kører på port ${PORT}`);
    console.log(`Webhook URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`);
});