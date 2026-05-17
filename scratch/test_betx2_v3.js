/**
 * test_betx2_v3.js
 * اختبار مباشر: فتح sport.betx2.com والتفاعل مع لوحة COUPON DE PARI
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
puppeteer.use(StealthPlugin());

const TEST_TICKET_ID = '12345678'; // رقم تذكرة للاختبار

(async () => {
    let browser;
    try {
        const paths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
        let executablePath;
        for (const p of paths) { if (fs.existsSync(p)) { executablePath = p; break; } }

        browser = await puppeteer.launch({
            headless: false, // مرئي لمتابعة ما يحدث
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
        });

        // الخطوة 1: جلب URL الـ iframe من الصفحة الرئيسية
        console.log('[1] تحميل الصفحة الرئيسية...');
        const mainPage = await browser.newPage();
        await mainPage.setViewport({ width: 1366, height: 768 });
        await mainPage.goto('https://betx2.com/fr/sport', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 4000));

        const sportIframeUrl = await mainPage.evaluate(() => {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            for (const f of iframes) {
                if (f.src && f.src.includes('sport.betx2.com')) return f.src;
            }
            return null;
        });
        console.log('[2] URL الـ iframe:', sportIframeUrl ? 'وُجد ✓' : 'لم يُوجد ✗');
        await mainPage.close();

        // الخطوة 2: فتح الـ iframe مباشرة
        const targetUrl = sportIframeUrl ||
            'https://sport.betx2.com/afdb6836-2b81-4931-a030-8a97d61a13d6/SportsBook/Home?token=-&d=d&l=fr&tz=&parent=betx2.com&sportsBookView=europeanView';

        console.log('[3] الانتقال إلى صفحة الرياضة...');
        const sportPage = await browser.newPage();
        await sportPage.setViewport({ width: 1366, height: 2000 }); // أطول لتغطية لوحة COUPON
        await sportPage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 5000));

        await sportPage.screenshot({ path: 'betx2_v3_step1_loaded.png' });
        console.log('[3] لقطة شاشة محفوظة: betx2_v3_step1_loaded.png');

        // الخطوة 3: النقر على COUPON DE PARI
        console.log('[4] البحث عن زر COUPON DE PARI...');
        const couponResult = await sportPage.evaluate(() => {
            const knownSels = ['.dg_bs_slip_bar','[class*="slip_bar"]','[class*="coupon_bar"]','[class*="bs_bar"]'];
            for (const sel of knownSels) {
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) { el.click(); return 'class:' + sel; }
            }
            const texts = ['coupon de pari', 'paris enregistr', 'vérificateur'];
            for (const el of Array.from(document.querySelectorAll('*'))) {
                if (el.children.length < 4) {
                    const t = (el.textContent || '').toLowerCase().trim();
                    if (texts.some(x => t.startsWith(x))) {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) { el.click(); return 'text:' + t.substring(0, 50); }
                    }
                }
            }
            return 'لم يُوجد';
        });
        console.log('[4] نتيجة النقر:', couponResult);
        await new Promise(r => setTimeout(r, 3000));
        await sportPage.screenshot({ path: 'betx2_v3_step2_coupon.png' });
        console.log('[4] لقطة: betx2_v3_step2_coupon.png');

        // الخطوة 4: فحص جميع inputs المتاحة
        const inputsInfo = await sportPage.evaluate(() => {
            return Array.from(document.querySelectorAll('input')).map(el => {
                const r = el.getBoundingClientRect();
                return { type: el.type, placeholder: el.placeholder, className: el.className, visible: r.width > 0 && r.height > 0, top: Math.round(r.top) };
            });
        });
        console.log('[5] Inputs المتاحة:', JSON.stringify(inputsInfo, null, 2));

        // الخطوة 5: الكتابة في الحقل
        const inputSelectors = [
            'input.dg_bs_book_input', 'input[class*="book_input"]',
            'input[placeholder*="nregistrement"]', 'input[placeholder*="oupon"]'
        ];
        // استخدام evaluate() للكتابة مباشرةً في JS داخل الصفحة (حل لعدم قابلية النقر الخارجي)
        const inputResult = await sportPage.evaluate((ticketId) => {
            const sels = [
                'input.dg_bs_book_input', 'input[class*="book_input"]',
                'input[placeholder*="nregistrement"]', 'input[placeholder*="oupon"]'
            ];
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el) {
                    el.scrollIntoView({ block: 'center' });
                    el.focus();
                    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    niv.call(el, ticketId);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, sel, val: el.value };
                }
            }
            return { success: false };
        }, TEST_TICKET_ID);
        const typed = inputResult && inputResult.success;
        if (typed) console.log('[6] كتبت رقم التذكرة في:', inputResult.sel, 'القيمة:', inputResult.val);
        else console.log('[6] لم يتم إيجاد الحقل بالـ selectors المعروفة');

        if (typed) {
            // النقر على Confirmer بنفس الطريقة
            const confirmResult = await sportPage.evaluate(() => {
                const sels = ['button.dg_bs_book_btn', '[class*="book_btn"]', '[class*="confirm_btn"]'];
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (el && el.getBoundingClientRect().width > 0) { el.click(); return 'class:' + sel; }
                }
                for (const b of document.querySelectorAll('button,[role="button"]')) {
                    const t = (b.textContent || '').toLowerCase().trim();
                    if (t.includes('confirm') || t.includes('vérif') || t === 'ok') { b.click(); return 'text:' + t; }
                }
                return false;
            });
            console.log('[7] زر Confirmer:', confirmResult);
        }

        await new Promise(r => setTimeout(r, 1000));
        await sportPage.screenshot({ path: 'betx2_v3_step3_typed.png' });
        console.log('[6] لقطة: betx2_v3_step3_typed.png');

        console.log('\n✅ انتهى الاختبار. افحص اللقطات للتحقق من النتيجة.');
        await new Promise(r => setTimeout(r, 5000)); // وقت للمشاهدة

    } catch (e) {
        console.error('❌ خطأ:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
