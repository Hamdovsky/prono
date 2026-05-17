/**
 * Smart Selector Utility
 * Implements "Self-Healing" element discovery for Puppeteer
 */

const SmartSelector = {
    /**
     * Logic to be injected into page.evaluate()
     */
    findInPage: (intent) => {
        const { tags = ['button', 'input', 'a', 'div', 'span'], textPatterns = [], classPatterns = [], attributes = [] } = intent;
        
        const candidates = [];
        const allElements = document.querySelectorAll(tags.join(','));

        for (const el of allElements) {
            let score = 0;
            const text = (el.textContent || el.value || '').toLowerCase().trim();
            const className = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const placeholder = (el.placeholder || '').toLowerCase();

            // 1. Check Text Patterns
            for (const pattern of textPatterns) {
                if (text.includes(pattern.toLowerCase())) score += 50;
                if (text === pattern.toLowerCase()) score += 20;
            }

            // 2. Check Class Patterns
            for (const pattern of classPatterns) {
                if (className.includes(pattern.toLowerCase())) score += 30;
            }

            // 3. Check IDs
            for (const pattern of classPatterns) {
                if (id.includes(pattern.toLowerCase())) score += 30;
            }

            // 4. Check Placeholders (for inputs)
            for (const pattern of textPatterns) {
                if (placeholder.includes(pattern.toLowerCase())) score += 40;
            }

            // 5. Check Visibility
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
            if (!isVisible) score = 0;

            if (score > 0) {
                candidates.push({
                    element: el,
                    score: score,
                    tag: el.tagName,
                    text: text.substring(0, 20),
                    selector: SmartSelector.getUniqueSelector(el)
                });
            }
        }

        // Sort by score descending
        candidates.sort((a, b) => b.score - a.score);
        return candidates.length > 0 ? candidates[0] : null;
    },

    /**
     * Generates a unique CSS selector for an element to help "repair" the system
     */
    getUniqueSelector: (el) => {
        if (el.id) return `#${el.id}`;
        let path = [];
        while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.className) {
                const classes = el.className.trim().split(/\s+/).join('.');
                if (classes) selector += `.${classes}`;
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(' > ');
    }
};

module.exports = SmartSelector;
