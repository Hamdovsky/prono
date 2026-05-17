/**
 * AFRICANOBET COOKIE EXTRACTOR — Node.js + PowerShell AesGcm
 * Utilise un script PS1 temporaire pour le déchiffrement natif
 */
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');

const CHROME_DATA = path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\User Data');
const OUTPUT      = path.resolve(__dirname, '../data/africanobet_cookies.json');
const TARGET      = 'africanobet.com';
const profiles    = ['Default','Profile 3','Profile 4','Profile 5',
                     'Profile 7','Profile 8','Profile 9','Profile 10','Profile 11','Profile 12'];

// ── Get AES key via a dedicated PS1 temp file (avoids escaping issues) ────────
function getAesKey() {
    const tmpPs1 = path.join(os.tmpdir(), `get_key_${Date.now()}.ps1`);
    const ps1 = `
Add-Type -AssemblyName System.Security
$state = Get-Content '${path.join(CHROME_DATA, 'Local State').replace(/\\/g,'/')}' -Raw | ConvertFrom-Json
$encB64 = $state.os_crypt.encrypted_key
$encFull = [System.Convert]::FromBase64String($encB64)
$enc = $encFull[5..($encFull.Length-1)]
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Convert]::ToBase64String($key)
`.trim();
    try {
        fs.writeFileSync(tmpPs1, ps1, 'utf8');
        const result = execFileSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', tmpPs1], 
            { encoding: 'utf8', timeout: 15000 }).trim();
        fs.unlinkSync(tmpPs1);
        return result ? Buffer.from(result, 'base64') : null;
    } catch(e) {
        try { fs.unlinkSync(tmpPs1); } catch(_) {}
        console.log('  [AES key error]', e.message.slice(0, 80));
        return null;
    }
}

// ── AES-256-GCM decrypt in Node ───────────────────────────────────────────────
function decryptAES(buf, aesKey) {
    try {
        const nonce = buf.slice(3, 15);
        const tag   = buf.slice(-16);
        const data  = buf.slice(15, -16);
        if (data.length === 0) return '';
        const d = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    } catch(_) { return ''; }
}

// ── DPAPI decrypt via PS1 temp file ──────────────────────────────────────────
function decryptDPAPI(encBase64) {
    const tmpPs1 = path.join(os.tmpdir(), `dpapi_${Date.now()}.ps1`);
    const ps1 = `
Add-Type -AssemblyName System.Security
$b = [System.Convert]::FromBase64String('${encBase64}')
$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($d)
`.trim();
    try {
        fs.writeFileSync(tmpPs1, ps1, 'utf8');
        const result = execFileSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', tmpPs1],
            { encoding: 'utf8', timeout: 10000 }).trim();
        fs.unlinkSync(tmpPs1);
        return result;
    } catch(_) {
        try { fs.unlinkSync(tmpPs1); } catch(__) {}
        return '';
    }
}

function decryptCookie(encBuf, aesKey) {
    if (!encBuf || encBuf.length === 0) return '';
    const buf    = Buffer.isBuffer(encBuf) ? encBuf : Buffer.from(encBuf);
    const prefix = buf.slice(0, 3).toString();
    if (prefix === 'v10' || prefix === 'v11') {
        return aesKey ? decryptAES(buf, aesKey) : '[AES-LOCKED]';
    }
    // Legacy DPAPI
    return decryptDPAPI(buf.toString('base64'));
}

// ── Scan profile ─────────────────────────────────────────────────────────────
function scanProfile(profileName, aesKey) {
    const candidates = [
        path.join(CHROME_DATA, profileName, 'Network', 'Cookies'),
        path.join(CHROME_DATA, profileName, 'Cookies'),
    ];
    const dbPath = candidates.find(p => fs.existsSync(p));
    if (!dbPath) return [];

    const sizeKB = Math.round(fs.statSync(dbPath).size / 1024);
    const tmp    = path.join(os.tmpdir(), `ck_${Date.now()}.db`);

    try {
        fs.copyFileSync(dbPath, tmp);
        const db   = new Database(tmp, { readonly: true });
        const total= db.prepare('SELECT COUNT(*) as n FROM cookies').get();
        const rows = db.prepare(
            `SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
             FROM cookies WHERE host_key LIKE ? ORDER BY name`
        ).all(`%${TARGET}%`);
        db.close();
        fs.unlinkSync(tmp);

        if (rows.length > 0 || sizeKB > 40) {
            console.log(`  Profile: ${profileName.padEnd(12)} | ${sizeKB}KB | Total: ${total.n} | Africanobet: ${rows.length}`);
        }

        return rows.map(row => {
            const enc     = row.encrypted_value;
            const encBuf  = enc && enc.length > 0 ? Buffer.from(enc) : Buffer.alloc(0);
            const value   = decryptCookie(encBuf, aesKey);
            const expires = row.expires_utc
                ? Math.floor((Number(row.expires_utc) - 11644473600000000) / 1000000) : 0;
            if (value) console.log(`    ✅ ${row.name.padEnd(28)} = ${value.slice(0, 50)}`);
            else       console.log(`    ⚠️  ${row.name.padEnd(28)} = [vide]`);
            return {
                name: row.name, value,
                domain: row.host_key, path: row.path || '/',
                expires, httpOnly: !!row.is_httponly,
                secure: !!row.is_secure,
                sameSite: ['Strict','Lax','None'][row.samesite] || 'None'
            };
        });
    } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
        return [];
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function run() {
    console.log('\n============================================');
    console.log('CHROME COOKIE EXTRACTOR — Africanobet');
    console.log('============================================\n');

    console.log('Recuperation de la cle AES Chrome...');
    const aesKey = getAesKey();
    console.log(aesKey ? `Cle AES OK (${aesKey.length} bytes)\n` : 'Cle AES indisponible\n');

    let all = [];
    for (const p of profiles) {
        const cookies = scanProfile(p, aesKey);
        all = all.concat(cookies);
    }

    const seen  = new Set();
    const unique = all.filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; });
    const valid  = unique.filter(c => c.value && c.value.length > 0);

    console.log(`\nRESULTAT: ${all.length} cookies africanobet trouves | ${valid.length} dechiffres\n`);

    if (all.length === 0) {
        console.log('ERREUR: Aucun cookie africanobet.com trouve.');
        console.log('  -> Assurez-vous d\'etre connecte dans Chrome (Profile 4).');
        console.log('  -> Fermez Chrome completement avant de relancer.');
        process.exit(1);
    }

    const toSave = valid.length > 0 ? valid : unique;
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(toSave, null, 2));

    console.log(`SAUVEGARDE: ${toSave.length} cookies -> ${OUTPUT}`);
    console.log('\nLance maintenant: node scripts/africanobet_scraper.js\n');
}

run();
