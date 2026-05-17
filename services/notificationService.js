/**
 * Notification Service
 * Sends notifications for scraper failures and important events
 */

const notifier = require('node-notifier');
const logger = require('../core/logger');
const botService = require('./botService');

class NotificationService {
    constructor() {
        this.enabled = process.env.ENABLE_NOTIFICATIONS !== 'false';
        this.telegramEnabled = process.env.NOTIFICATION_TELEGRAM === 'true';
        this.systemEnabled = process.env.NOTIFICATION_SYSTEM !== 'false';
        this.lastNotifications = new Map(); // Prevent spam
        this.cooldown = 5 * 60 * 1000; // 5 minutes cooldown
    }

    /**
     * Check if notification can be sent (cooldown)
     */
    canSend(type) {
        const last = this.lastNotifications.get(type);
        if (!last) return true;
        return Date.now() - last > this.cooldown;
    }

    /**
     * Send system notification (Windows/Mac/Linux)
     */
    sendSystemNotification(title, message, level = 'info') {
        if (!this.enabled || !this.systemEnabled) return;

        try {
            notifier.notify({
                title: `⚽ Stitch - ${title}`,
                message: message,
                sound: level === 'error',
                wait: false,
                icon: level === 'error' ? undefined : undefined
            });
        } catch (error) {
            logger.error('System notification error:', error.message);
        }
    }

    /**
     * Send Telegram notification
     */
    async sendTelegramNotification(message) {
        if (!this.enabled || !this.telegramEnabled) return;

        try {
            if (botService && botService.chatId && botService.token) {
                await botService.sendAlert(message);
            }
        } catch (error) {
            logger.error('Telegram notification error:', error.message);
        }
    }

    /**
     * Notify scraper failure
     */
    async notifyScraperFailure(failureCount, error) {
        const type = 'scraper_failure';
        if (!this.canSend(type)) return;

        const message = `❌ Scraper a échoué ${failureCount} fois\nErreur: ${error}`;

        logger.error(message);
        this.sendSystemNotification('Scraper Failure', message, 'error');
        await this.sendTelegramNotification(message);

        this.lastNotifications.set(type, Date.now());
    }

    /**
     * Notify no matches found
     */
    async notifyNoMatches(duration) {
        const type = 'no_matches';
        if (!this.canSend(type)) return;

        const message = `⚠️ Aucun match trouvé depuis ${duration} minutes`;

        logger.warn(message);
        this.sendSystemNotification('No Matches', message, 'warning');
        await this.sendTelegramNotification(message);

        this.lastNotifications.set(type, Date.now());
    }

    /**
     * Notify Redis disconnection
     */
    async notifyRedisDisconnected() {
        const type = 'redis_disconnected';
        if (!this.canSend(type)) return;

        const message = '🔴 Redis déconnecté - Utilisation du cache de secours';

        logger.warn(message);
        this.sendSystemNotification('Redis Disconnected', message, 'warning');
        await this.sendTelegramNotification(message);

        this.lastNotifications.set(type, Date.now());
    }

    /**
     * Notify high latency
     */
    async notifyHighLatency(latency) {
        const type = 'high_latency';
        if (!this.canSend(type)) return;

        const message = `⚡ Latence élevée détectée: ${latency}ms`;

        logger.warn(message);
        this.sendSystemNotification('High Latency', message, 'warning');
        await this.sendTelegramNotification(message);

        this.lastNotifications.set(type, Date.now());
    }

    /**
     * Notify scraper success (after failures)
     */
    async notifyScraperRecovered() {
        const type = 'scraper_recovered';
        if (!this.canSend(type)) return;

        const message = '✅ Scraper récupéré - Fonctionnement normal';

        logger.info(message);
        this.sendSystemNotification('Scraper Recovered', message, 'info');
        await this.sendTelegramNotification(message);

        this.lastNotifications.set(type, Date.now());
    }

    /**
     * Notify matches found (after drought)
     */
    async notifyMatchesFound(count) {
        const type = 'matches_found';
        if (!this.canSend(type)) return;

        const message = `✅ ${count} matchs trouvés - Scraping actif`;

        logger.info(message);
        this.sendSystemNotification('Matches Found', message, 'info');
        await this.sendTelegramNotification(message);

        this.lastNotifications.set(type, Date.now());
    }
}

// Singleton instance
const notificationService = new NotificationService();

module.exports = notificationService;
