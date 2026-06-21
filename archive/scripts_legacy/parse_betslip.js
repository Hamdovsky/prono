const fs = require('fs');

const html = fs.readFileSync('betslip_shadow.html', 'utf8');

// The betslip usually has a class like Betslip-sc- or something, or we can just extract all button texts
const buttonMatches = html.match(/<button[^>]*>([\s\S]*?)<\/button>/gi);

if (buttonMatches) {
    buttonMatches.forEach(b => {
        // extract text content
        const text = b.replace(/<[^>]+>/g, '').trim();
        if (text) {
            console.log('Button:', text);
        } else {
            console.log('Button with no text (possibly icon)');
        }
    });
} else {
    console.log('No buttons found in HTML');
}
