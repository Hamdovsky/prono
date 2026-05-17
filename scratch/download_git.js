const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');

const ZIP_URL = 'https://github.com/git-for-windows/git/releases/download/v2.45.1.windows.1/MinGit-2.45.1-64-bit.zip';
const TOOLS_DIR = path.resolve(__dirname, '../tools');
const ZIP_PATH = path.join(TOOLS_DIR, 'mingit.zip');
const GIT_DEST = path.join(TOOLS_DIR, 'git');

// Ensure tools directory exists
if (!fs.existsSync(TOOLS_DIR)) {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
}

console.log('📡 Downloading portable Git (MinGit) from GitHub releases...');
console.log(`🔗 URL: ${ZIP_URL}`);

const file = fs.createWriteStream(ZIP_PATH);

https.get(ZIP_URL, (response) => {
    if (response.statusCode !== 200) {
        console.error(`❌ HTTP Error: ${response.statusCode}`);
        return;
    }
    
    response.pipe(file);
    
    file.on('finish', () => {
        file.close(() => {
            console.log('✅ Download complete! Starting extraction...');
            try {
                // Ensure target folder exists and is empty
                if (fs.existsSync(GIT_DEST)) {
                    fs.rmSync(GIT_DEST, { recursive: true, force: true });
                }
                fs.mkdirSync(GIT_DEST, { recursive: true });
                
                // Use PowerShell's native Expand-Archive cmdlet
                console.log(`📦 Unzipping to: ${GIT_DEST}...`);
                execSync(`powershell -Command "Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${GIT_DEST}' -Force"`, { stdio: 'inherit' });
                console.log('🎉 Portable Git extracted successfully!');
                
                // Clean up zip
                fs.unlinkSync(ZIP_PATH);
                console.log('🗑️ Temporary zip file cleaned up!');
            } catch (e) {
                console.error(`❌ Extraction failed: ${e.message}`);
            }
        });
    });
}).on('error', (err) => {
    fs.unlinkSync(ZIP_PATH);
    console.error(`❌ Download failed: ${err.message}`);
});
