#!/usr/bin/env node
/**
 * Automated Deployment Script for Titanium AI
 * Handles deployment to Render with pre-flight checks
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function checkGitStatus() {
  log('\n🔍 Checking Git status...', 'cyan');
  
  try {
    const { stdout } = await execPromise('git status --porcelain');
    
    if (stdout.trim()) {
      log('⚠️  Uncommitted changes detected:', 'yellow');
      console.log(stdout);
      
      const answer = await promptUser('Continue anyway? (yes/no): ');
      if (answer.toLowerCase() !== 'yes') {
        log('❌ Deployment cancelled', 'red');
        process.exit(1);
      }
    } else {
      log('✅ Working directory clean', 'green');
    }
  } catch (err) {
    log('❌ Git check failed', 'red');
    throw err;
  }
}

async function runTests() {
  log('\n🧪 Running tests...', 'cyan');
  
  try {
    // Node.js tests
    log('Running Node.js tests...', 'blue');
    await execPromise('npm test');
    log('✅ Node.js tests passed', 'green');
    
    // Python tests (optional)
    try {
      log('Running Python tests...', 'blue');
      await execPromise('pytest tests/ -v --tb=short');
      log('✅ Python tests passed', 'green');
    } catch (err) {
      log('⚠️  Python tests failed or not available', 'yellow');
      const answer = await promptUser('Continue deployment? (yes/no): ');
      if (answer.toLowerCase() !== 'yes') {
        log('❌ Deployment cancelled', 'red');
        process.exit(1);
      }
    }
  } catch (err) {
    log('❌ Tests failed', 'red');
    log(err.stderr || err.error.message, 'red');
    process.exit(1);
  }
}

async function checkEnvVariables() {
  log('\n🔐 Checking environment variables...', 'cyan');
  
  const requiredEnvVars = [
    'DATABASE_URL',
    'API_SECRET_KEY',
    'NODE_ENV'
  ];
  
  const missing = [];
  
  for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }
  
  if (missing.length > 0) {
    log('⚠️  Missing environment variables:', 'yellow');
    missing.forEach(v => log(`   - ${v}`, 'yellow'));
    log('\nMake sure these are set on Render Dashboard', 'yellow');
  } else {
    log('✅ All required environment variables present', 'green');
  }
}

async function getCurrentBranch() {
  const { stdout } = await execPromise('git branch --show-current');
  return stdout.trim();
}

async function commitAndPush(env) {
  log('\n📝 Committing changes...', 'cyan');
  
  const branch = await getCurrentBranch();
  
  try {
    // Check if there are changes to commit
    const { stdout: status } = await execPromise('git status --porcelain');
    
    if (status.trim()) {
      const commitMsg = `deploy: ${env} deployment ${new Date().toISOString()}`;
      
      await execPromise('git add .');
      await execPromise(`git commit -m "${commitMsg}"`);
      log(`✅ Committed changes: ${commitMsg}`, 'green');
    } else {
      log('ℹ️  No changes to commit', 'blue');
    }
    
    // Push to remote
    log(`🚀 Pushing to ${branch}...`, 'cyan');
    await execPromise(`git push origin ${branch}`);
    log(`✅ Pushed to origin/${branch}`, 'green');
    
  } catch (err) {
    log('❌ Git operations failed', 'red');
    log(err.stderr || err.error.message, 'red');
    throw err;
  }
}

async function deployToRender(env) {
  log(`\n🚀 Deploying to Render (${env})...`, 'cyan');
  
  log('ℹ️  Render auto-deploys on git push', 'blue');
  log('ℹ️  Check deployment status at: https://dashboard.render.com', 'blue');
  
  if (env === 'production') {
    log('\n⚠️  PRODUCTION DEPLOYMENT', 'yellow');
    log('   - Monitor logs for errors', 'yellow');
    log('   - Check /api/health endpoint', 'yellow');
    log('   - Verify predictions work correctly', 'yellow');
  }
  
  log('\n✅ Deployment initiated successfully', 'green');
}

async function promptUser(question) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    readline.question(question, (answer) => {
      readline.close();
      resolve(answer);
    });
  });
}

async function main() {
  log('\n' + '='.repeat(60), 'cyan');
  log('   TITANIUM AI - AUTOMATED DEPLOYMENT', 'cyan');
  log('='.repeat(60) + '\n', 'cyan');
  
  // Determine environment
  const args = process.argv.slice(2);
  const env = args[0] || 'production';
  
  if (!['staging', 'production'].includes(env)) {
    log('❌ Invalid environment. Use: staging or production', 'red');
    process.exit(1);
  }
  
  log(`Environment: ${env.toUpperCase()}`, 'blue');
  
  try {
    // Pre-flight checks
    await checkGitStatus();
    await checkEnvVariables();
    
    // Confirm deployment
    log(`\n⚠️  Ready to deploy to ${env.toUpperCase()}`, 'yellow');
    const confirm = await promptUser('Continue? (yes/no): ');
    
    if (confirm.toLowerCase() !== 'yes') {
      log('❌ Deployment cancelled', 'red');
      process.exit(0);
    }
    
    // Run tests
    await runTests();
    
    // Commit and push
    await commitAndPush(env);
    
    // Deploy
    await deployToRender(env);
    
    log('\n' + '='.repeat(60), 'green');
    log('   ✅ DEPLOYMENT COMPLETED SUCCESSFULLY', 'green');
    log('='.repeat(60) + '\n', 'green');
    
    log('Next steps:', 'cyan');
    log('1. Monitor Render logs', 'blue');
    log('2. Check /api/health endpoint', 'blue');
    log('3. Verify predictions working', 'blue');
    log('4. Monitor RAM usage in Render dashboard', 'blue');
    
  } catch (err) {
    log('\n' + '='.repeat(60), 'red');
    log('   ❌ DEPLOYMENT FAILED', 'red');
    log('='.repeat(60) + '\n', 'red');
    
    console.error(err);
    process.exit(1);
  }
}

// Run deployment
main();
