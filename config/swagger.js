/**
 * Swagger API Documentation Configuration
 * Auto-generated docs for all REST endpoints
 */

const swaggerJsdoc = require('swagger-jsdoc')
const swaggerUi = require('swagger-ui-express')

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Titanium AI - Football Prediction API',
      version: '3.1.0',
      description:
        'Advanced AI-powered football prediction platform with XGBoost, Monte Carlo, and adaptive learning',
      contact: {
        name: 'Titanium AI Team',
        url: 'https://pronostico.onrender.com',
      },
      license: {
        name: 'Private',
        url: 'https://pronostico.onrender.com',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Development server',
      },
      {
        url: 'https://pronostico.onrender.com',
        description: 'Production server (Render)',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API Secret Key for authentication',
        },
      },
      schemas: {
        Match: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'Match ID' },
            homeTeam: { type: 'string', description: 'Home team name' },
            awayTeam: { type: 'string', description: 'Away team name' },
            league: { type: 'string', description: 'League/competition name' },
            startTimestamp: { type: 'integer', description: 'Match start time (Unix timestamp)' },
            status: {
              type: 'string',
              enum: ['scheduled', 'live', 'finished'],
              description: 'Match status',
            },
            home_xg: { type: 'number', description: 'Home team expected goals' },
            away_xg: { type: 'number', description: 'Away team expected goals' },
          },
        },
        Prediction: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              description: 'Prediction verdict (e.g., SAFE BET, STRONG BET)',
            },
            selection: {
              type: 'string',
              enum: ['Home', 'Draw', 'Away'],
              description: 'Predicted outcome',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description: 'Confidence percentage',
            },
            expected_score: {
              type: 'array',
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2,
              description: 'Expected score [home, away]',
            },
            probabilities: {
              type: 'object',
              properties: {
                home: { type: 'number', minimum: 0, maximum: 1 },
                draw: { type: 'number', minimum: 0, maximum: 1 },
                away: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
            surgical_markets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: 'Market type (e.g., AH -0.5, O/U 2.5)' },
                  probability: { type: 'number', minimum: 0, maximum: 1 },
                  value: { type: 'number', description: 'Value index' },
                },
              },
            },
          },
        },
        HealthCheck: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ONLINE' },
            uptime: { type: 'integer', description: 'Server uptime in seconds' },
            memory: {
              type: 'object',
              properties: {
                heapUsed: { type: 'string', example: '150MB' },
                heapTotal: { type: 'string', example: '200MB' },
                rss: { type: 'string', example: '250MB' },
              },
            },
            model_manager: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                mode: { type: 'string', enum: ['optimized', 'legacy'] },
              },
            },
            database: {
              type: 'object',
              properties: {
                connected: { type: 'boolean' },
                matches: { type: 'integer' },
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', description: 'Error message' },
          },
        },
      },
    },
    security: [
      {
        ApiKeyAuth: [],
      },
    ],
  },
  apis: ['./routes/*.js', './server.js'],
}

const specs = swaggerJsdoc(options)

module.exports = { specs, swaggerUi }
