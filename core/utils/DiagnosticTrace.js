/**
 * DiagnosticTrace
 * أداة لتسجيل خطوات المعالجة، التوقيت، وحالة مصادر البيانات.
 */

class DiagnosticTrace {
    constructor() {
        this.startTime = Date.now();
        this.steps = [];
        this.errors = [];
        this.sources = {};
    }

    step(name, details = {}) {
        const timestamp = Date.now() - this.startTime;
        this.steps.push({ name, timestamp, ...details });
        // console.log(`🔍 [TRACE] ${name} (+${timestamp}ms)`);
    }

    error(module, message, stack = null) {
        this.errors.push({ module, message, stack, timestamp: Date.now() - this.startTime });
        // console.error(`❌ [TRACE ERROR] ${module}: ${message}`);
    }

    source(name, status, details = {}) {
        this.sources[name] = { status, ...details, timestamp: Date.now() - this.startTime };
    }

    getSummary() {
        return {
            duration_ms: Date.now() - this.startTime,
            steps_count: this.steps.length,
            errors_count: this.errors.length,
            sources: this.sources,
            trace: this.steps,
            critical_errors: this.errors
        };
    }
}

module.exports = DiagnosticTrace;
