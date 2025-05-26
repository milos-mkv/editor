const https = require('https');
const fs = require('fs');
const path = require('path');

const FENGARI_URL = 'https://fengari.io/static/js/fengari-web.js';
const OUTPUT_PATH = path.join(__dirname, 'fengari-web.js');

console.log('Downloading Fengari...');

https.get(FENGARI_URL, (response) => {
    if (response.statusCode !== 200) {
        console.error(`Failed to download Fengari: ${response.statusCode}`);
        return;
    }

    const file = fs.createWriteStream(OUTPUT_PATH);
    response.pipe(file);

    file.on('finish', () => {
        file.close();
        console.log('Fengari downloaded successfully!');
    });
}).on('error', (err) => {
    console.error('Error downloading Fengari:', err.message);
}); 