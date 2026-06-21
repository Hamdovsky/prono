const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function triggerV24Automation() {
    console.log("🤖 [V24 AUTO-TRAINING] Initiating Automated Top Analyst Training Pipeline...");
    const pythonScript = path.join(__dirname, '..', 'core', 'train_v24_top_analyst.py');
    
    if (!fs.existsSync(pythonScript)) {
        console.error("❌ Cannot find training script at: " + pythonScript);
        process.exit(1);
    }
    
    // Spawn the python process
    const py = spawn('python', [pythonScript]);
    
    py.stdout.on('data', (d) => {
        process.stdout.write(d.toString());
    });
    
    py.stderr.on('data', (d) => {
        process.stderr.write(d.toString());
    });
    
    py.on('close', (code) => {
        if (code === 0) {
            console.log("\n✅ [V24 AUTO-TRAINING] Successfully completed model generation.");
            console.log("-> New Model Path: stitch/models/stitch_v24_hybrid.json");
            console.log("-> This model is now ready to replace V23 in prediction_engine.py");
        } else {
            console.error(`\n❌ [V24 AUTO-TRAINING] Failed with exit code ${code}.`);
        }
        process.exit(code);
    });
}

triggerV24Automation();
