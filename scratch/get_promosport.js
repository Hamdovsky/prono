const { scrapePromosport } = require('../core/promosport_scraper');

scrapePromosport().then(matches => {
    console.log(JSON.stringify(matches, null, 2));
}).catch(err => {
    console.error(err);
});
