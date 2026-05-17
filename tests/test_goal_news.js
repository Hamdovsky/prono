const goalNewsService = require('../services/goalNewsService');

async function testNews() {
    console.log('🧪 Testing Goal.com News Service...');
    
    // Testing with a major team to ensure RSS items exist
    const team = "Chelsea"; 
    console.log(`🔍 Fetching news for ${team}...`);
    
    const news = await goalNewsService.getTeamNews(team);
    if (news) {
        console.log('✅ News Found:');
        console.log(`   - Title: ${news.latestTitle}`);
        console.log(`   - Sentiment: ${news.sentiment}`);
        console.log(`   - Tags: ${news.tags.join(', ')}`);
        
        const impact = goalNewsService.calculateNewsImpact(news);
        console.log('📊 Calculated Impact:');
        console.log(`   - Att Mod: ${impact.att}`);
        console.log(`   - Def Mod: ${impact.def}`);
    } else {
        console.log('⚠️ No news found for this team right now (or feed empty).');
    }
    
    process.exit(0);
}

testNews();
