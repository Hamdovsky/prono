const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const BANKROLL_PATH = path.join(__dirname, '../data/bankroll.json');

function getBankroll() {
    if (!fs.existsSync(BANKROLL_PATH)) {
        return { current_balance: 1000.0, stats: {} };
    }
    return JSON.parse(fs.readFileSync(BANKROLL_PATH, 'utf8'));
}

function saveBankroll(data) {
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(BANKROLL_PATH, JSON.stringify(data, null, 4));
}

function updateBalance(amount) {
    const data = getBankroll();
    const oldBalance = data.current_balance;
    data.current_balance += amount;
    
    if (amount > 0) data.stats.total_won = (data.stats.total_won || 0) + amount;
    else data.stats.total_lost = (data.stats.total_lost || 0) + Math.abs(amount);
    
    saveBankroll(data);
    console.log(chalk.green(`✅ Balance Updated: ${chalk.bold(oldBalance)} -> ${chalk.bold(data.current_balance)}`));
}

function showStatus() {
    const data = getBankroll();
    const profit = data.current_balance - data.initial_balance;
    const roi = ((data.current_balance / data.initial_balance - 1) * 100).toFixed(2);

    console.log(chalk.blue.bold('\n💰 [BANKROLL STATUS]'));
    console.log(`- Balance Actuelle : ${chalk.yellow(data.current_balance.toFixed(2))} ${data.currency}`);
    console.log(`- Profit Total     : ${profit >= 0 ? chalk.green('+' + profit.toFixed(2)) : chalk.red(profit.toFixed(2))}`);
    console.log(`- ROI Global       : ${roi >= 0 ? chalk.green(roi + '%') : chalk.red(roi + '%')}`);
    console.log(`- Dernière MAJ     : ${new Date(data.last_updated).toLocaleString()}`);
}

const args = process.argv.slice(2);
const command = args[0];

if (command === 'status') {
    showStatus();
} else if (command === 'add' && args[1]) {
    updateBalance(parseFloat(args[1]));
} else if (command === 'remove' && args[1]) {
    updateBalance(-parseFloat(args[1]));
} else {
    console.log('Usage: node manage_bankroll.js [status | add <amount> | remove <amount>]');
}
