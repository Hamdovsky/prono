const axios = require('axios');

async function checkHtml() {
    const url = 'http://www.promosportplus.com/promosport-concours-de-la-semaine';
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const index = response.data.indexOf('Man City');
        console.log(response.data.substring(index - 500, index + 5000));
    } catch (e) {
        console.error(e);
    }
}

checkHtml();
