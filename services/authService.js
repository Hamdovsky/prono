const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const logger = require('../core/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'titanium-dev-secret-change-in-prod';
const JWT_EXPIRES = '7d';
const SALT_ROUNDS = 10;

class AuthService {
    constructor() {
        this.db = null;
    }

    getDb() {
        if (!this.db) {
            const database = require('../core/database');
            this.db = database.db || database;
        }
        return this.db;
    }

    async register(username, email, password, role = 'user') {
        const db = this.getDb();
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) throw new Error('Username already exists');

        if (email) {
            const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
            if (emailExists) throw new Error('Email already registered');
        }

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = db.prepare(
            'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
        ).run(username, email || null, passwordHash, role);

        const user = { id: result.lastInsertRowid, username, email, role };
        const token = this.generateToken(user);

        logger.info(`👤 [AUTH] New user registered: ${username} (role: ${role})`);
        return { user, token };
    }

    async login(username, password) {
        const db = this.getDb();
        const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
        if (!user) throw new Error('Invalid credentials');

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) throw new Error('Invalid credentials');

        db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

        const token = this.generateToken({ id: user.id, username: user.username, role: user.role });
        logger.info(`✅ [AUTH] User logged in: ${user.username}`);

        return {
            user: { id: user.id, username: user.username, email: user.email, role: user.role },
            token
        };
    }

    generateToken(payload) {
        return jwt.sign(
            { id: payload.id, username: payload.username, role: payload.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES }
        );
    }

    verifyToken(token) {
        try {
            return jwt.verify(token, JWT_SECRET);
        } catch (e) {
            return null;
        }
    }

    authenticate(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid token' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = decoded;
        next();
    }

    requireRole(...roles) {
        return (req, res, next) => {
            if (!req.user || !roles.includes(req.user.role)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            next();
        };
    }
}

module.exports = new AuthService();
