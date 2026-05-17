
const express = require('express');
const router = require('../routes/analytics');
const database = require('../core/database');
const logger = require('../core/logger');

// Mock a response object
const res = {
    json: (data) => {
        console.log('API Response Success:', data.success);
        console.log('Picks Count:', data.count);
        if (data.picks && data.picks.length > 0) {
            console.log('Sample Pick:', data.picks[0]);
        }
    },
    status: (code) => ({
        json: (data) => {
            console.log('API Response Error:', code, data);
        }
    })
};

// Mock a request object
const req = {};

// Find the handler for /high-scoring
const handler = router.stack.find(s => s.route && s.route.path === '/high-scoring').route.stack[0].handle;

async function testEndpoint() {
    console.log('Testing /api/high-scoring endpoint logic...');
    try {
        await handler(req, res);
    } catch (err) {
        console.error('Error in handler:', err);
    }
}

testEndpoint();
