import dotenv from 'dotenv'
dotenv.config()

interface Config {
  env: string
  isDev: () => boolean
  isProd: () => boolean
  databaseUrl: string
  usePostgres: boolean
  redisUrl: string
  apiSecretKey: string
  services: {
    web: string
    fastapi: string
    scraper: string
    redis: string
  }
  football: {
    bsd: string
    rapidApi: { key: string; host: string; dailyLimit: number }
    footballData: { key: string; host: string; dailyLimit: number }
    therundown: string
    oddspapi: string
    sportmonks: string
    apifootball: string
    openweather: string
    predixSport: string
  }
  supabase: {
    enabled: boolean
    url: string
    anonKey: string
    serviceRoleKey: string
  }
  ai: {
    groq: string
    gemini: string
  }
  telegram: {
    botToken: string
    chatId: string
  }
  render: {
    inferenceUrl: string
    viteApiUrl: string
    scraperWorkerUrl: string
  }
  features: {
    predictionEnrichment: boolean
    livePredictions: boolean
    autoLearning: boolean
    httpScraper: boolean
    openligadb: boolean
    supabase: boolean
  }
  memory: {
    maxOldSpaceSize: number
  }
  [key: string]: unknown
}

const config: Config = {
  env: process.env.NODE_ENV || 'development',
  isDev: () => (process.env.NODE_ENV || 'development') === 'development',
  isProd: () => process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL || '',
  usePostgres: !!process.env.DATABASE_URL,

  redisUrl: process.env.REDIS_URL || '',

  apiSecretKey: process.env.API_SECRET_KEY || '',

  services: {
    web: process.env.WEB_SERVICE_URL || 'http://localhost:3001',
    fastapi: process.env.INFERENCE_URL || 'http://127.0.0.1:8000',
    scraper: process.env.SCRAPER_WORKER_URL || '',
    redis: process.env.REDIS_URL || '',
  },

  football: {
    bsd: process.env.BSD_API_KEY || '',
    rapidApi: {
      key: process.env.RAPIDAPI_KEY || '',
      host: process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com',
      dailyLimit: parseInt(process.env.RAPIDAPI_DAILY_LIMIT || '20'),
    },
    footballData: {
      key: process.env.FOOTBALLDATA_KEY || '',
      host: process.env.FOOTBALLDATA_HOST || 'footballdata.io',
      dailyLimit: parseInt(process.env.FOOTBALLDATA_DAILY_LIMIT || '20'),
    },
    therundown: process.env.THERUNDOWN_KEY || '',
    oddspapi: process.env.ODDSPAPI_KEY || '',
    sportmonks: process.env.SPORTMONKS_KEY || '',
    apifootball: process.env.APIFOOTBALL_KEY || '',
    openweather: process.env.OPENWEATHER_KEY || '',
    predixSport: process.env.PREDIXSPORT_KEY || '',
  },

  supabase: {
    enabled: process.env.SUPABASE_ENABLED === 'true',
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  ai: {
    groq: process.env.GROQ_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || '',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  render: {
    inferenceUrl: process.env.INFERENCE_URL || 'http://127.0.0.1:8000',
    viteApiUrl: process.env.VITE_API_URL || 'https://pronostico.onrender.com',
    scraperWorkerUrl: process.env.SCRAPER_WORKER_URL || 'https://pronostico.onrender.com',
  },

  features: {
    predictionEnrichment: process.env.ENABLE_PREDICTION_ENRICHMENT !== 'false',
    livePredictions: process.env.ENABLE_LIVE_PREDICTIONS !== 'false',
    autoLearning: process.env.ENABLE_AUTO_LEARNING !== 'false',
    httpScraper: process.env.HTTP_SCRAPER_ENABLED !== 'false',
    openligadb: process.env.OPENLIGADB_ENABLED === 'true',
    supabase: process.env.SUPABASE_ENABLED === 'true',
  },

  memory: {
    maxOldSpaceSize: parseInt(
      process.env.NODE_OPTIONS?.match(/--max-old-space-size=(\d+)/)?.[1] || '256'
    ),
  },
}

Object.freeze(config)
Object.freeze(config.services)
Object.freeze(config.features)

export = config
