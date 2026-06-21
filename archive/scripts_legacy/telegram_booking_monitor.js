/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  telegram_booking_monitor.js
 *  مراقب أكواد الحجز من تلغرام — جميع المنصات العالمية
 *  مكتبة: GramJS (npm: telegram)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  الإعداد (مرة واحدة فقط):
 *    1. احصل على API_ID و API_HASH من https://my.telegram.org/auth
 *    2. انسخهم إلى ملف .env أو عدّل الثوابت أدناه مباشرة
 *    3. شغّل: node scripts/telegram_booking_monitor.js
 *    4. عند أول تشغيل سيطلب رقم هاتفك + كود OTP (مرة واحدة)
 *       ثم يحفظ الـ session في session.json تلقائياً
 */

'use strict';

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { NewMessage }     = require('telegram/events');
const readline           = require('readline');
const fs                 = require('fs');
const path               = require('path');

// ─── ⚙️  إعدادات ─────────────────────────────────────────────────────────────
const CONFIG = {
    // ← أدخل بياناتك هنا (أو استخدم متغيرات البيئة)
    API_ID:   parseInt(process.env.TG_API_ID   || '0'),
    API_HASH:         process.env.TG_API_HASH  || '',
    PHONE:            process.env.TG_PHONE     || '',       // مثال: +21620000000

    // مسارات الملفات
    SESSION_FILE:  path.join(__dirname, '..', 'data', 'telegram_session.json'),
    DB_FILE:       path.join(__dirname, '..', 'data', 'booking_codes.json'),
    LOG_FILE:      path.join(__dirname, '..', 'data', 'telegram_monitor.log'),

    // مراقبة جميع المحادثات؟ false = only specified CHANNELS below
    MONITOR_ALL: true,

    // إذا أردت تحديد قنوات بعينها ضعها هنا (username أو id):
    CHANNELS: [
        // 'pronostics_gratuits',
        // 'betting_codes_vip',
    ],

    // كم ساعة تُعدّ "اليوم" (24 = رسائل منذ منتصف الليل)
    TODAY_HOURS: 24,

    // الحدّ الأقصى لعدد الإعادة عند الخطأ
    MAX_RETRIES: 10,

    // تأخير بين المحاولات (ms)
    RETRY_DELAY_MS: 5000,
};

// ─── 🔎  خوارزمية Regex لكل منصة ────────────────────────────────────────────
const PLATFORMS = [
    {
        name:    '1Xbet',
        keywords: ['1xbet', '1x bet', '1-xbet'],
        // 1Xbet: 5–8 رموز (أرقام + أحرف صغيرة وكبيرة مختلطة)
        patterns: [
            /\b([A-Za-z0-9]{5,8})\b(?=\s*(?:code|coupon|booking|code de r[eé]servation|كود|بوكينج|كوبون))/gi,
            /(?:code|coupon|booking|ref)\s*[:\-=]\s*([A-Za-z0-9]{4,10})/gi,
            /\b([a-z0-9]{5,8})\b/gi,   // fallback — short alphanum
        ],
        confidence: 0.7,
    },
    {
        name:    'Betwinner',
        keywords: ['betwinner', 'bet winner'],
        patterns: [
            /\b([A-Za-z0-9]{5,8})\b(?=\s*(?:code|coupon|booking))/gi,
            /(?:code|coupon|booking)\s*[:\-=]\s*([A-Za-z0-9]{4,10})/gi,
            /\b([a-z0-9]{5,8})\b/gi,
        ],
        confidence: 0.7,
    },
    {
        name:    'Bibeet',
        keywords: ['bibeet'],
        // Altenar platform: 4–6 uppercase alphanumeric
        patterns: [
            /\b([A-Z0-9]{4,6})\b/g,
            /(?:code|booking|réservation|كود)\s*[:\-=]?\s*([A-Z0-9]{4,6})/gi,
        ],
        confidence: 0.8,
    },
    {
        name:    'Betx2',
        keywords: ['betx2', 'bet x2', 'betx 2'],
        // Altenar platform: 4–6 uppercase alphanumeric
        patterns: [
            /\b([A-Z0-9]{4,6})\b/g,
            /(?:code|booking)\s*[:\-=]?\s*([A-Z0-9]{4,6})/gi,
        ],
        confidence: 0.8,
    },
    {
        name:    'Planetwin365',
        keywords: ['planetwin', 'planetwin365', 'planet win'],
        // Raqami long codes or alpha+num combos
        patterns: [
            /\b(\d{6,12})\b/g,
            /\b([A-Z]{2,4}\d{4,10})\b/g,
            /(?:codice|code|booking)\s*[:\-=]?\s*([A-Z0-9]{6,14})/gi,
        ],
        confidence: 0.75,
    },
    {
        name:    'ParionsSport',
        keywords: ['parionssport', 'parions sport', 'parions'],
        // French platform: Numeric IDs or short codes
        patterns: [
            /\b(\d{7,12})\b/g,
            /(?:code|coupon|partager)\s*[:\-=]?\s*([A-Z0-9]{4,12})/gi,
        ],
        confidence: 0.75,
    },
    {
        name:    'Betclic',
        keywords: ['betclic'],
        patterns: [
            /\b(\d{6,12})\b/g,
            /(?:code|coupon|partage)\s*[:\-=]?\s*([A-Z0-9]{5,12})/gi,
        ],
        confidence: 0.7,
    },
    {
        name:    'SportyBet',
        keywords: ['sportybet', 'sporty bet'],
        patterns: [
            /\b([A-Z0-9]{5,10})\b/g,
            /(?:code|booking|coupon)\s*[:\-=]?\s*([A-Z0-9]{5,10})/gi,
        ],
        confidence: 0.75,
    },
    {
        name:    'Bet9ja',
        keywords: ['bet9ja', 'bet 9ja'],
        // Bet9ja booking codes: typically 8 alphanumeric uppercase
        patterns: [
            /\b([A-Z0-9]{7,10})\b/g,
            /(?:booking|code)\s*[:\-=]?\s*([A-Z0-9]{7,10})/gi,
        ],
        confidence: 0.8,
    },
];

// Patterns that should NEVER be a booking code
const FALSE_POSITIVE_BLACKLIST = new Set([
    'LIVE','TODAY','GOAL','FREE','ODDS','TIPS','PICK','SURE','OVER','UNDER',
    'HOME','AWAY','DRAW','BTTS','BOTH','TEAM','HALF','FULL','TIME','GAME',
    'MATCH','WIN','LOSE','DRAW','INFO','NEWS','JOIN','LINK','NEXT','BEST',
    'SPORT','DAILY','LUCKY','BONUS','CASH','RATE','HIGH','RISK','SAFE',
    'SINGLE','MULTI','COMBO','ACCA','PARLAY','BOOST','PROMO','CODE',
    'BETSLIP','TICKET','SLIP','VOID','POST','USER','PAID',
]);

// ─── 💾  قاعدة البيانات المحلية ──────────────────────────────────────────────
class BookingDatabase {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = { codes: [], meta: { lastUpdated: null, total: 0 } };
        this._ensureDir();
        this._load();
    }

    _ensureDir() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    _load() {
        if (fs.existsSync(this.filePath)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            } catch {
                this.data = { codes: [], meta: { lastUpdated: null, total: 0 } };
            }
        }
    }

    _save() {
        this.data.meta.lastUpdated = new Date().toISOString();
        this.data.meta.total = this.data.codes.length;
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }

    /** إنشاء Unique ID لكل كود */
    _uid(platform, code, channel) {
        return `${platform}:${code}:${channel}`.toLowerCase().replace(/\s+/g, '_');
    }

    /**
     * أضف كوداً جديداً — يُعيد true إذا كان جديداً، false إذا كان مكرراً
     */
    add(entry) {
        const uid = this._uid(entry.platform, entry.code, entry.channel);
        const exists = this.data.codes.some((c) => c.uid === uid);
        if (exists) return false;

        this.data.codes.push({ ...entry, uid });
        this._save();
        return true;
    }

    /** جلب أكواد اليوم */
    getTodayCodes() {
        const since = Date.now() - CONFIG.TODAY_HOURS * 3600 * 1000;
        return this.data.codes.filter((c) => new Date(c.foundAt).getTime() > since);
    }

    getAll() { return this.data.codes; }
}

// ─── 🧠  محرك الاستخراج ──────────────────────────────────────────────────────
class BookingExtractor {

    /** هل يذكر النص منصةً معينة؟ */
    detectPlatform(text) {
        const lower = text.toLowerCase();
        return PLATFORMS.filter((p) =>
            p.keywords.some((kw) => lower.includes(kw))
        );
    }

    /** استخراج الأكواد من نص ─ يُعيد [{ platform, code, confidence }] */
    extract(text) {
        if (!text || text.trim().length < 3) return [];

        const results = [];
        const platforms = this.detectPlatform(text);

        // إذا لم تُكتشف منصة معينة، نجرّب الكل
        const targets = platforms.length > 0 ? platforms : PLATFORMS;

        for (const platform of targets) {
            const codes = new Set();
            for (const pattern of platform.patterns) {
                // نسخ الـ regex لتجنب مشكلة lastIndex
                const re = new RegExp(pattern.source, pattern.flags);
                let match;
                while ((match = re.exec(text)) !== null) {
                    const candidate = (match[1] || match[0]).trim().toUpperCase();

                    // فلاتر أساسية
                    if (candidate.length < 4)                     continue;
                    if (FALSE_POSITIVE_BLACKLIST.has(candidate))  continue;
                    if (/^\d+$/.test(candidate) && candidate.length < 6) continue; // أرقام قصيرة جداً
                    if (/^[A-Z]+$/.test(candidate) && candidate.length < 5) continue; // حروف فقط قصيرة

                    codes.add(candidate);
                }
            }

            for (const code of codes) {
                // لا نكرر نفس الكود لنفس المنصة
                const alreadyAdded = results.some(
                    (r) => r.platform === platform.name && r.code === code
                );
                if (!alreadyAdded) {
                    results.push({
                        platform:   platform.name,
                        code,
                        confidence: platform.confidence,
                        detected:   platforms.some((p) => p.name === platform.name),
                    });
                }
            }
        }

        return results;
    }
}

// ─── 📋  Logger ───────────────────────────────────────────────────────────────
class Logger {
    constructor(logFile) {
        this.logFile = logFile;
        this._ensureDir();
    }
    _ensureDir() {
        const dir = path.dirname(this.logFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    _write(level, msg) {
        const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
        console.log(line);
        fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    }
    info(msg)  { this._write('INFO ', msg); }
    warn(msg)  { this._write('WARN ', msg); }
    error(msg) { this._write('ERROR', msg); }
    code(entry) {
        const confidence = entry.detected ? '✅' : '⚠️ ';
        const msg = `${confidence} [${entry.platform.padEnd(14)}] | 📦 ${entry.code.padEnd(12)} | 📢 ${entry.channel.padEnd(30)} | 🕐 ${entry.time}`;
        this._write('CODE ', msg);
    }
}

// ─── 🖥️  Helper: Readline prompt ─────────────────────────────────────────────
function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    });
}

// ─── 🌐  المراقب الرئيسي ─────────────────────────────────────────────────────
class TelegramBookingMonitor {
    constructor() {
        this.db        = new BookingDatabase(CONFIG.DB_FILE);
        this.extractor = new BookingExtractor();
        this.logger    = new Logger(CONFIG.LOG_FILE);
        this.client    = null;
        this.retries   = 0;
        this._ensureDataDir();
    }

    _ensureDataDir() {
        const dir = path.dirname(CONFIG.DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    /** تحميل أو إنشاء الـ session */
    _loadSession() {
        if (fs.existsSync(CONFIG.SESSION_FILE)) {
            try {
                const raw = JSON.parse(fs.readFileSync(CONFIG.SESSION_FILE, 'utf8'));
                this.logger.info('📂 Session found — resuming...');
                return new StringSession(raw.session || '');
            } catch { /* fall through */ }
        }
        this.logger.info('🆕 No session found — will authenticate.');
        return new StringSession('');
    }

    /** حفظ الـ session */
    _saveSession(sessionString) {
        fs.writeFileSync(
            CONFIG.SESSION_FILE,
            JSON.stringify({ session: sessionString, savedAt: new Date().toISOString() }),
            'utf8'
        );
        this.logger.info('💾 Session saved.');
    }

    /** تهيئة العميل */
    async _initClient() {
        if (!CONFIG.API_ID || !CONFIG.API_HASH) {
            this.logger.error('❌ API_ID أو API_HASH غير موجود! أضفهم في CONFIG أو متغيرات البيئة.');
            process.exit(1);
        }

        const session = this._loadSession();

        this.client = new TelegramClient(session, CONFIG.API_ID, CONFIG.API_HASH, {
            connectionRetries: 5,
            retryDelay:        2000,
            autoReconnect:     true,
        });

        await this.client.start({
            phoneNumber:  async () => CONFIG.PHONE || prompt('📱 رقم هاتفك (مع رمز الدولة): '),
            password:     async () => prompt('🔑 كلمة سر 2FA (اتركها فارغة إن لم تكن مفعّلة): '),
            phoneCode:    async () => prompt('📩 كود OTP من تلغرام: '),
            onError:      (err)    => this.logger.error(`Auth error: ${err.message}`),
        });

        // حفظ الـ session بعد المصادقة
        this._saveSession(this.client.session.save());
        this.logger.info(`✅ متصل بتلغرام كـ: ${(await this.client.getMe()).username || '(no username)'}`);
    }

    /** هل الرسالة اليوم؟ */
    _isToday(date) {
        if (!date) return false;
        const msgTime   = new Date(date * 1000);
        const threshold = new Date(Date.now() - CONFIG.TODAY_HOURS * 3600 * 1000);
        return msgTime >= threshold;
    }

    /** معالجة رسالة واحدة */
    async _processMessage(event) {
        try {
            const msg   = event.message;
            const date  = msg.date;

            // تجاهل الرسائل القديمة
            if (!this._isToday(date)) return;

            // نص الرسالة (قد يكون caption للصور)
            const text = msg.message || msg.text || '';
            if (!text || text.trim().length < 4) return;

            // اسم القناة / المحادثة
            let channelName = 'unknown';
            try {
                const chat = await msg.getChat();
                channelName = chat?.username || chat?.title || chat?.firstName || `id:${chat?.id}`;
            } catch { /* keep 'unknown' */ }

            // وقت الرسالة
            const msgDate = new Date(date * 1000);
            const timeStr = msgDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

            // الاستخراج
            const found = this.extractor.extract(text);
            if (found.length === 0) return;

            for (const item of found) {
                const entry = {
                    platform:  item.platform,
                    code:      item.code,
                    channel:   channelName,
                    time:      timeStr,
                    date:      msgDate.toISOString(),
                    text:      text.slice(0, 200),
                    detected:  item.detected,
                    confidence: item.confidence,
                    foundAt:   new Date().toISOString(),
                };

                const isNew = this.db.add(entry);
                if (isNew) {
                    this.logger.code(entry);
                }
            }
        } catch (err) {
            this.logger.warn(`processMessage error: ${err.message}`);
        }
    }

    /** مسح رسائل اليوم من القنوات المحددة عند بدء التشغيل */
    async _fetchHistorical() {
        this.logger.info('📜 Fetching historical messages for today...');
        const since = Math.floor((Date.now() - CONFIG.TODAY_HOURS * 3600 * 1000) / 1000);

        try {
            const dialogs = await this.client.getDialogs({ limit: 200 });
            let checked = 0;

            for (const dialog of dialogs) {
                // إذا كانت قائمة قنوات محددة، فلترها
                if (CONFIG.CHANNELS.length > 0) {
                    const identifier = dialog.entity?.username || String(dialog.entity?.id);
                    if (!CONFIG.CHANNELS.includes(identifier)) continue;
                }

                // جلب رسائل اليوم فقط
                try {
                    const messages = await this.client.getMessages(dialog.entity, {
                        limit:      100,
                        offsetDate: Math.floor(Date.now() / 1000), // ابدأ من الآن للخلف
                        reverse:    false,
                    });

                    for (const msg of messages) {
                        if (msg.date < since) continue;
                        const fakeEvent = { message: msg };
                        await this._processMessage(fakeEvent);
                    }
                    checked++;
                } catch (e) {
                    this.logger.warn(`Could not fetch from ${dialog.entity?.username || 'unknown'}: ${e.message}`);
                }
            }

            this.logger.info(`✅ Historical scan done — checked ${checked} channels/groups.`);
        } catch (err) {
            this.logger.error(`Historical fetch error: ${err.message}`);
        }
    }

    /** مراقبة الرسائل الجديدة في الوقت الفعلي */
    _startRealtime() {
        this.logger.info('👁️  Real-time monitoring started...');

        this.client.addEventHandler(async (event) => {
            await this._processMessage(event);
        }, new NewMessage({}));
    }

    /** طباعة ملخص الأكواد التي عثر عليها */
    _printSummary() {
        const today = this.db.getTodayCodes();
        if (today.length === 0) {
            this.logger.info('📊 لا أكواد موجودة لليوم حتى الآن.');
            return;
        }
        this.logger.info(`\n${'═'.repeat(70)}`);
        this.logger.info(`📊 ملخص أكواد اليوم — ${today.length} كود:`);
        for (const c of today) {
            this.logger.info(`   [${c.platform}] ${c.code} — قناة: ${c.channel} — ${c.time}`);
        }
        this.logger.info(`${'═'.repeat(70)}\n`);
    }

    /** تشغيل المراقب مع إعادة المحاولة عند الانقطاع */
    async start() {
        this.logger.info('═'.repeat(70));
        this.logger.info('🤖 Telegram Booking Monitor — بدء التشغيل');
        this.logger.info(`📁 قاعدة البيانات: ${CONFIG.DB_FILE}`);
        this.logger.info(`📋 السجل: ${CONFIG.LOG_FILE}`);
        this.logger.info('═'.repeat(70));

        while (this.retries < CONFIG.MAX_RETRIES) {
            try {
                await this._initClient();
                await this._fetchHistorical();
                this._printSummary();
                this._startRealtime();

                // ملخص كل ساعة
                setInterval(() => this._printSummary(), 3600 * 1000);

                // ابق يعمل
                this.logger.info('⏳ المراقب يعمل... اضغط Ctrl+C للإيقاف.');
                await new Promise(() => {});  // block forever

            } catch (err) {
                this.retries++;
                this.logger.error(`❌ خطأ (محاولة ${this.retries}/${CONFIG.MAX_RETRIES}): ${err.message}`);

                if (this.retries >= CONFIG.MAX_RETRIES) {
                    this.logger.error('🛑 تجاوزنا الحد الأقصى للمحاولات. يتوقف...');
                    process.exit(1);
                }

                this.logger.info(`♻️  إعادة المحاولة بعد ${CONFIG.RETRY_DELAY_MS / 1000}s...`);
                await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY_MS));
            }
        }
    }
}

// ─── 🚀  نقطة الانطلاق ───────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED]', reason);
});

process.on('SIGINT', () => {
    console.log('\n👋 المراقب توقف.');
    process.exit(0);
});

new TelegramBookingMonitor().start().catch(console.error);
