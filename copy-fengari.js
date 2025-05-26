const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, 'node_modules', 'fengari-web', 'dist', 'fengari-web.js');
const DEST_PATH = path.join(__dirname, 'fengari-web.js');

console.log('Copying Fengari from node_modules...');

try {
    fs.copyFileSync(SOURCE_PATH, DEST_PATH);
    console.log('Fengari copied successfully!');
} catch (err) {
    console.error('Error copying Fengari:', err.message);
} 