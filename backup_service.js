// TN-INTEL Backup Service - Automated Data Protection
const fs = require('fs');
const path = require('path');

// Optional dependency - node-cron
let cron = null;
try {
    cron = require('node-cron');
} catch (e) {
    console.log('[BACKUP] node-cron not installed. Run: npm install node-cron');
}

class BackupService {
    constructor() {
        this.backupDir = path.join(__dirname, 'backups');
        this.patternsFile = path.join(__dirname, 'data', 'patterns.json');
        this.weightsFile = path.join(__dirname, 'data', 'model_weights.json');

        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    _getTimestamp() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}`;
    }

    backupPatterns() {
        try {
            if (!fs.existsSync(this.patternsFile)) {
                console.log('[BACKUP] No patterns file to backup');
                return;
            }

            const timestamp = this._getTimestamp();
            const backupPath = path.join(this.backupDir, `patterns_${timestamp}.json`);

            fs.copyFileSync(this.patternsFile, backupPath);
            console.log(`✅ [BACKUP] Patterns backed up: ${backupPath}`);

            // Cleanup old backups (keep last 168 = 7 days × 24 hours)
            this._cleanupOldBackups('patterns', 168);
        } catch (error) {
            console.error(`❌ [BACKUP] Failed to backup patterns:`, error.message);
        }
    }

    backupWeights() {
        try {
            if (!fs.existsSync(this.weightsFile)) {
                return;
            }

            const timestamp = this._getTimestamp();
            const backupPath = path.join(this.backupDir, `weights_${timestamp}.json`);

            fs.copyFileSync(this.weightsFile, backupPath);
            console.log(`✅ [BACKUP] Weights backed up: ${backupPath}`);

            // Keep last 30 versions
            this._cleanupOldBackups('weights', 30);
        } catch (error) {
            console.error(`❌ [BACKUP] Failed to backup weights:`, error.message);
        }
    }

    _cleanupOldBackups(type, keep) {
        try {
            const files = fs.readdirSync(this.backupDir)
                .filter(f => f.startsWith(type))
                .sort()
                .reverse();

            if (files.length > keep) {
                const toDelete = files.slice(keep);
                toDelete.forEach(file => {
                    fs.unlinkSync(path.join(this.backupDir, file));
                });
                console.log(`🗑️  [BACKUP] Cleaned up ${toDelete.length} old ${type} backups`);
            }
        } catch (error) {
            console.error(`❌ [BACKUP] Cleanup failed:`, error.message);
        }
    }

    restore(type, timestamp) {
        try {
            const backupFile = path.join(this.backupDir, `${type}_${timestamp}.json`);

            if (!fs.existsSync(backupFile)) {
                console.error(`❌ [RESTORE] Backup not found: ${backupFile}`);
                return false;
            }

            const targetFile = type === 'patterns' ? this.patternsFile : this.weightsFile;

            // Create safety backup of current file
            if (fs.existsSync(targetFile)) {
                fs.copyFileSync(targetFile, `${targetFile}.before_restore`);
            }

            // Restore from backup
            fs.copyFileSync(backupFile, targetFile);
            console.log(`✅ [RESTORE] Restored ${type} from ${timestamp}`);
            return true;
        } catch (error) {
            console.error(`❌ [RESTORE] Failed:`, error.message);
            return false;
        }
    }

    startAutomatedBackups() {
        if (!cron) {
            console.log('⚠️  [BACKUP] Automated backups disabled (node-cron not installed)');
            console.log('   Manual backup: node backup_service.js backup');
            // Do initial backup manually
            this.backupPatterns();
            return;
        }

        // Hourly pattern backups (at :00)
        cron.schedule('0 * * * *', () => {
            this.backupPatterns();
        });

        // Daily cleanup (at 03:00)
        cron.schedule('0 3 * * *', () => {
            this._cleanupOldBackups('patterns', 168);
            this._cleanupOldBackups('weights', 30);
        });

        console.log('🔄 [BACKUP] Automated backup system started');
        console.log('   - Patterns: hourly backup, keep 7 days');
        console.log('   - Weights: backup on change, keep 30 versions');

        // Initial backup
        this.backupPatterns();
    }
}

// CLI for manual restore
if (require.main === module) {
    const args = process.argv.slice(2);
    const service = new BackupService();

    if (args[0] === 'restore') {
        const type = args.find(a => a.startsWith('--type='))?.split('=')[1];
        const timestamp = args.find(a => a.startsWith('--timestamp='))?.split('=')[1];

        if (!type || !timestamp) {
            console.error('Usage: node backup_service.js restore --type=patterns --timestamp=YYYY-MM-DD_HH');
            process.exit(1);
        }

        service.restore(type, timestamp);
    } else {
        console.log('Commands:');
        console.log('  node backup_service.js restore --type=patterns --timestamp=2026-02-07_11');
    }
} else {
    module.exports = new BackupService();
}
