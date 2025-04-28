require('dotenv').config();
const express = require('express');
const app = express();
const Dropbox = require('dropbox-v2-api');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const dropbox = Dropbox.authenticate({
    token: process.env.DROPBOX_TOKEN
});

// Test-endpoint til at afprøve fakturagenerering
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server kører på port ${PORT}`);
});