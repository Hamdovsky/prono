const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function ensureChrome() {
    const platforms = {
        win32: {
            paths: [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            ]
        },
        linux: {
            paths: [
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/snap/bin/chromium',
            ]
        },
        darwin: {
            paths: [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            ]
        }
    };

    const os = process.platform;
    const platformPaths = platforms[os] || { paths: [] };

    for (const p of platformPaths.paths) {
        if (fs.existsSync(p)) {
            console.log(`✅ Chrome/Chromium found at: ${p}`);
            return p;
        }
    }

    console.log('📦 Trying Puppeteer bundled Chromium...');
    try {
        let puppeteerMod;
        try { puppeteerMod = require('puppeteer-extra'); } catch (_) { puppeteerMod = require('puppeteer'); }
        const execPath = puppeteerMod.executablePath();
        if (execPath && fs.existsSync(execPath)) {
            console.log(`✅ Puppeteer Chromium found at: ${execPath}`);
            process.env.PUPPETEER_EXECUTABLE_PATH = execPath;
            return execPath;
        }
    } catch (e) {
        console.warn('⚠️ Puppeteer Chromium not available:', e.message);
    }

    if (os === 'linux') {
        console.log('📦 Chrome not found. Attempting to install...');
        try {
            execSync('which apt-get && apt-get update && apt-get install -y chromium-browser || which apk && apk add chromium', {
                stdio: 'inherit',
                timeout: 120000
            });
            for (const p of platformPaths.paths) {
                if (fs.existsSync(p)) {
                    console.log(`✅ Chrome installed at: ${p}`);
                    process.env.PUPPETEER_EXECUTABLE_PATH = p;
                    return p;
                }
            }
        } catch (e) {
            console.warn('⚠️ Could not install Chrome via package manager:', e.message);
        }
    }

    console.log('⚠️ No Chrome/Chromium found. Scraper will use HTTP fallback.');
    return null;
}

if (require.main === module) {
    ensureChrome().then(() => process.exit(0)).catch(() => process.exit(0));
}

module.exports = { ensureChrome };
