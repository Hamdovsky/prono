#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = 7;

function log(msg) { console.log(`[BACKUP ${new Date().toISOString()}] ${msg}`); }

async function backupSQLite() {
    const dbPath = path.join(__dirname, '..', 'tactical.db');
    if (!fs.existsSync(dbPath)) {
        log('⚠️ tactical.db not found, skipping SQLite backup');
        return;
    }
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `tactical_${ts}.db`);
    fs.copyFileSync(dbPath, backupFile);

    const sizeMB = (fs.statSync(backupFile).size / 1024 / 1024).toFixed(2);
    log(`✅ SQLite backup: ${backupFile} (${sizeMB} MB)`);
    return backupFile;
}

function backupPostgres() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        log('⚠️ DATABASE_URL not set, skipping PG backup');
        return null;
    }
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dumpFile = path.join(BACKUP_DIR, `neon_${ts}.sql`);
    try {
        execSync(`pg_dump "${dbUrl}" > "${dumpFile}" 2>&1`, { timeout: 60000 });
        const sizeKB = (fs.statSync(dumpFile).size / 1024).toFixed(2);
        log(`✅ PostgreSQL backup: ${dumpFile} (${sizeKB} KB)`);
        return dumpFile;
    } catch (e) {
        log(`⚠️ pg_dump failed (may need psql): ${e.message}`);
        return null;
    }
}

function cleanupOldBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.db') || f.endsWith('.sql'))
        .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
        .sort((a, b) => b.time - a.time);

    const toDelete = files.slice(MAX_BACKUPS);
    for (const f of toDelete) {
        fs.unlinkSync(path.join(BACKUP_DIR, f.name));
        log(`🗑️ Removed old backup: ${f.name}`);
    }
}

async function main() {
    log('🔄 Starting DB backup...');
    await backupSQLite();
    backupPostgres();
    cleanupOldBackups();
    log('🎯 Backup complete');
}

if (require.main === module) {
    main().catch(e => { log(`❌ Fatal: ${e.message}`); process.exit(1); });
}

module.exports = { backupSQLite, backupPostgres, cleanupOldBackups };
