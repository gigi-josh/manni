const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static('public'));

// ---------- Database ----------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('Unexpected DB error:', err));

// ---------- Constants ----------
const TRANSFER_WINDOW_START_DAY = 1;
const TRANSFER_WINDOW_END_DAY = 5;
const MIN_TRANSFER = 2500;
const TASK_COOLDOWN_SECONDS = 120;
const REFERRAL_BONUS_REFERRER = 600;
const REFERRAL_BONUS_NEW_USER = 300;
const RATE_LIMIT_PER_HOUR = 10;

// ---------- Helpers ----------
function isTransferWindowOpen() {
    const day = new Date().getDate();
    return day >= TRANSFER_WINDOW_START_DAY && day <= TRANSFER_WINDOW_END_DAY;
}

function nextTransferWindowStart() {
    const now = new Date();
    const day = now.getDate();
    if (day >= TRANSFER_WINDOW_START_DAY && day <= TRANSFER_WINDOW_END_DAY) return now;
    return new Date(now.getFullYear(), now.getMonth() + 1, TRANSFER_WINDOW_START_DAY);
}

function formatWindowDate(date) {
    return date.toLocaleDateString('en-NG', { month: 'long', day: 'numeric', year: 'numeric' });
}

function isEmail(str) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function isPhone(str) {
    return /^(\+234|0)[789][01]\d{8}$/.test(str);
}

function normalizePhone(str) {
    if (str.startsWith('0')) return '+234' + str.slice(1);
    return str;
}

function sanitizeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        balance: user.balance,
        pendingBalance: user.pending_balance,
        tasksCompleted: user.tasks_completed,
        referralCode: user.referral_code,
        referralEarnings: user.referral_earnings,
        referralCount: user.referral_count,
        createdAt: user.created_at
    };
}

async function findUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
}

async function findUserByIdentifier(identifier) {
    const trimmed = identifier.trim();
    const lower = trimmed.toLowerCase();
    const { rows } = await pool.query(
        `SELECT * FROM users WHERE LOWER(email) = $1 OR phone = $2 LIMIT 1`,
        [lower, trimmed]
    );
    return rows[0] || null;
}

async function getLastCompletionTime(userId) {
    const { rows } = await pool.query(
        `SELECT MAX(completed_at) AS last FROM task_completions WHERE user_id = $1`,
        [userId]
    );
    return rows[0].last ? new Date(rows[0].last).getTime() : 0;
}

async function getCooldownRemaining(userId) {
    const last = await getLastCompletionTime(userId);
    if (!last) return 0;
    const elapsed = (Date.now() - last) / 1000;
    return Math.max(0, Math.ceil(TASK_COOLDOWN_SECONDS - elapsed));
}

async function getRecentCompletionCount(userId) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM task_completions
         WHERE user_id = $1 AND completed_at > $2`,
        [userId, oneHourAgo]
    );
    return rows[0].count;
}

async function pickRandomVideoForUser(userId) {
    const unused = await pool.query(
        `SELECT * FROM videos
         WHERE active = TRUE
           AND id NOT IN (SELECT video_id FROM user_videos WHERE user_id = $1)
         ORDER BY RANDOM() LIMIT 1`,
        [userId]
    );
    if (unused.rows.length) return unused.rows[0];

    const any = await pool.query(
        `SELECT * FROM videos WHERE active = TRUE ORDER BY RANDOM() LIMIT 1`
    );
    return any.rows[0] || null;
}

function computeEffectiveStatus(task, progress) {
    if (!progress) return 'available';
    const baseStatus = progress.status;

    if (task.repeatable && baseStatus === 'completed') {
        return 'available';
    }

    if (baseStatus === 'completed' && task.renew_after_days && task.renew_after_days > 0) {
        const completedAt = progress.completed_at ? new Date(progress.completed_at).getTime() : 0;
        const daysSince = (Date.now() - completedAt) / (1000 * 60 * 60 * 24);
        if (daysSince >= task.renew_after_days) {
            return 'available';
        }
    }

    return baseStatus;
}

// ==================== DB INIT ====================
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE,
                phone VARCHAR(20) UNIQUE,
                password VARCHAR(255) NOT NULL,
                balance INTEGER DEFAULT 0,
                pending_balance INTEGER DEFAULT 0,
                tasks_completed INTEGER DEFAULT 0,
                referral_code VARCHAR(20) UNIQUE NOT NULL,
                referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                referral_code_used VARCHAR(20),
                referral_earnings INTEGER DEFAULT 0,
                referral_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                title VARCHAR(100) NOT NULL,
                description TEXT NOT NULL,
                reward INTEGER NOT NULL,
                category VARCHAR(30) NOT NULL,
                link TEXT,
                instructions TEXT NOT NULL,
                verification VARCHAR(20) NOT NULL,
                min_seconds INTEGER DEFAULT 0,
                active BOOLEAN DEFAULT TRUE,
                repeatable BOOLEAN DEFAULT FALSE,
                renew_after_days INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS videos (
                id SERIAL PRIMARY KEY,
                url TEXT NOT NULL,
                title VARCHAR(150),
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS user_videos (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                watched_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, video_id)
            );

            CREATE TABLE IF NOT EXISTS task_progress (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                status VARCHAR(20) DEFAULT 'available',
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                proof_url TEXT,
                admin_note TEXT,
                current_video_id INTEGER REFERENCES videos(id),
                UNIQUE(user_id, task_id)
            );

            CREATE TABLE IF NOT EXISTS task_completions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                reward INTEGER NOT NULL,
                video_id INTEGER REFERENCES videos(id),
                completed_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount INTEGER NOT NULL,
                bank_name VARCHAR(100) NOT NULL,
                account_number VARCHAR(10) NOT NULL,
                status VARCHAR(20) DEFAULT 'processing',
                requested_at TIMESTAMP DEFAULT NOW(),
                processed_at TIMESTAMP,
                admin_note TEXT
            );

            CREATE TABLE IF NOT EXISTS cpx_transactions (
                id SERIAL PRIMARY KEY,
                trans_id VARCHAR(100) UNIQUE NOT NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount INTEGER NOT NULL,
                reversed BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS withdraw_starts (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                started_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_task_progress_user ON task_progress(user_id);
            CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);
            CREATE INDEX IF NOT EXISTS idx_task_completions_time ON task_completions(completed_at);
            CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
            CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
            CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
            CREATE INDEX IF NOT EXISTS idx_user_videos_user ON user_videos(user_id);
            CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
            CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
        `);

        // Safe migrations for existing DBs
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='users' AND column_name='email' AND is_nullable='NO'
                ) THEN
                    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN
                    ALTER TABLE users ADD COLUMN phone VARCHAR(20) UNIQUE;
                END IF;

                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='users' AND column_name='phone' AND is_nullable='NO'
                ) THEN
                    ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='task_progress' AND column_name='current_video_id') THEN
                    ALTER TABLE task_progress ADD COLUMN current_video_id INTEGER REFERENCES videos(id);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='repeatable') THEN
                    ALTER TABLE tasks ADD COLUMN repeatable BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='renew_after_days') THEN
                    ALTER TABLE tasks ADD COLUMN renew_after_days INTEGER;
                END IF;
            END $$;
        `);

        // Renewal rules per task
        await pool.query(`UPDATE tasks SET repeatable = TRUE,  renew_after_days = NULL WHERE title = 'Watch Video'`);
        await pool.query(`UPDATE tasks SET repeatable = TRUE,  renew_after_days = NULL WHERE title = 'Read Article'`);
        await pool.query(`UPDATE tasks SET repeatable = TRUE,  renew_after_days = NULL WHERE title = 'Social Media Post'`);
        await pool.query(`UPDATE tasks SET repeatable = FALSE, renew_after_days = 3    WHERE title = 'Complete Survey'`);
        await pool.query(`UPDATE tasks SET repeatable = FALSE, renew_after_days = NULL WHERE title = 'Download App'`);

        await pool.query(`
            UPDATE task_progress tp
            SET status = 'available', started_at = NULL, current_video_id = NULL
            FROM tasks t
            WHERE tp.task_id = t.id
              AND tp.status = 'completed'
              AND (
                  t.repeatable = TRUE
                  OR (t.renew_after_days IS NOT NULL
                      AND tp.completed_at IS NOT NULL
                      AND tp.completed_at < NOW() - (t.renew_after_days || ' days')::INTERVAL)
              )
        `);

        // Seed default tasks
        const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM tasks');
        if (rows[0].count === 0) {
            await pool.query(`
                INSERT INTO tasks (title, description, reward, category, link, instructions, verification, min_seconds, repeatable, renew_after_days) VALUES
                ('Watch Video', 'Watch a short video and answer 2 quick questions', 50, 'Video', NULL, 'Watch the full video, then click "I''m Done"', 'video', 120, TRUE, NULL),
                ('Complete Survey', 'Share your opinion about fintech in Nigeria', 100, 'Survey', 'https://survey.example.com', 'Answer all questions, then submit a screenshot link', 'proof', 60, FALSE, 3),
                ('Download App', 'Download and install a Nigerian shopping app', 150, 'Download', 'https://play.google.com/store/apps/details?id=example', 'Install, open the app, and submit a screenshot link', 'proof', 60, FALSE, NULL),
                ('Social Media Post', 'Post about MannieNG on Instagram or Twitter', 75, 'Social', NULL, 'Post using #MannieNG and tag @MannieNG, then submit the post URL', 'proof', 0, TRUE, NULL),
                ('Read Article', 'Read a short article and answer 3 quick questions', 109, 'Article', 'https://example.com/article', 'Read the article carefully, then click "I''m Done"', 'timed', 90, TRUE, NULL)
            `);
            console.log('✅ Seeded default tasks');
        }

        // Seed default videos
        const vid = await pool.query('SELECT COUNT(*)::int AS count FROM videos');
        if (vid.rows[0].count === 0) {
            await pool.query(`
                INSERT INTO videos (url, title) VALUES
                ('https://www.youtube.com/embed/dQw4w9WgXcQ', 'Nigerian Culture Video'),
                ('https://www.youtube.com/embed/9bZkp7q19f0', 'Fintech in Africa'),
                ('https://www.youtube.com/embed/kJQP7kiw5Fk', 'Naija Music Hit'),
                ('https://www.youtube.com/embed/3JZ_D3ELwOQ', 'Lagos City Tour'),
                ('https://www.youtube.com/embed/hY7m5jjJ9mM', 'Nigerian Food Recipes')
            `);
            console.log('✅ Seeded default videos');
        }

        console.log('✅ Database tables ready');
    } catch (err) {
        console.error('❌ DB init failed:', err.message);
        throw err;
    }
}

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/ad/:taskId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ad.html')));
app.get('/surveys', (req, res) => res.sendFile(path.join(__dirname, 'public', 'surveys.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/transfer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transfer.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ==================== AUTH ====================

app.post('/api/register', async (req, res) => {
    const { username, identifier, password, ref } = req.body;

    if (!username || !identifier || !password) {
        return res.status(400).json({ error: 'Username, phone/email, and password are required' });
    }
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const idTrim = identifier.trim();
    let email = null;
    let phone = null;

    if (isEmail(idTrim)) {
        email = idTrim.toLowerCase();
    } else if (isPhone(idTrim)) {
        phone = normalizePhone(idTrim);
    } else {
        return res.status(400).json({ error: 'Enter a valid email address or Nigerian phone number' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userExists = await client.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userExists.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Username already taken' });
        }

        if (email) {
            const emExists = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
            if (emExists.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'An account with that email already exists' });
            }
        }
        if (phone) {
            const phExists = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
            if (phExists.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'An account with that phone number already exists' });
            }
        }

        let referrer = null, referralApplied = false, refCodeUsed = null;
        if (ref && typeof ref === 'string') {
            const code = ref.trim().toUpperCase();
            const r = await client.query('SELECT * FROM users WHERE referral_code = $1', [code]);
            if (r.rows.length) { referrer = r.rows[0]; referralApplied = true; refCodeUsed = code; }
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const signupBonus = referralApplied ? REFERRAL_BONUS_NEW_USER : 0;
        const newReferralCode = `MNG${Date.now().toString(36).toUpperCase()}`;

        const insert = await client.query(
            `INSERT INTO users (username, email, phone, password, balance, referral_code, referred_by, referral_code_used)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [username, email, phone, hashedPassword, signupBonus, newReferralCode,
             referrer ? referrer.id : null, refCodeUsed]
        );
        const newUser = insert.rows[0];

        const allTasks = await client.query('SELECT id FROM tasks WHERE active = TRUE');
        for (const t of allTasks.rows) {
            await client.query(
                `INSERT INTO task_progress (user_id, task_id, status) VALUES ($1, $2, 'available')
                 ON CONFLICT (user_id, task_id) DO NOTHING`,
                [newUser.id, t.id]
            );
        }

        if (referrer) {
            await client.query(
                `UPDATE users SET balance = balance + $1,
                                  referral_earnings = referral_earnings + $1,
                                  referral_count = referral_count + 1
                 WHERE id = $2`,
                [REFERRAL_BONUS_REFERRER, referrer.id]
            );
            console.log(`Referral: ₦${REFERRAL_BONUS_REFERRER} → ${referrer.username} (from ${newUser.username})`);
        }

        await client.query('COMMIT');
        res.status(201).json({
            message: referralApplied ? `Welcome! You earned a ₦${signupBonus} signup bonus.` : 'Registration successful!',
            user: sanitizeUser(newUser),
            referralApplied
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed. Try again.' });
    } finally { client.release(); }
});

app.post('/api/login', async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'Phone/email and password required' });

    try {
        const user = await findUserByIdentifier(identifier);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ message: 'Login successful!', user: sanitizeUser(user) });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed. Try again.' });
    }
});

// ==================== USER ====================

app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await findUserById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(sanitizeUser(user));
    } catch { res.status(500).json({ error: 'Failed to load user' }); }
});

// ==================== REFERRALS ====================

app.get('/api/referrals/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
        const user = await findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const { rows: referred } = await pool.query(
            'SELECT id, username, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC',
            [userId]
        );

        res.json({
            referralCode: user.referral_code,
            referralLink: `https://manni.onrender.com/register?ref=${user.referral_code}`,
            referralCount: user.referral_count || 0,
            referralEarnings: user.referral_earnings || 0,
            bonusReferrer: REFERRAL_BONUS_REFERRER,
            bonusNewUser: REFERRAL_BONUS_NEW_USER,
            referrals: referred.map(u => ({
                username: u.username, joinedAt: u.created_at, earned: REFERRAL_BONUS_REFERRER
            }))
        });
    } catch { res.status(500).json({ error: 'Failed to load referrals' }); }
});

// ==================== TASKS ====================

app.get('/api/tasks/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
        const user = await findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const { rows: taskRows } = await pool.query('SELECT * FROM tasks WHERE active = TRUE ORDER BY id');
        const { rows: progressRows } = await pool.query('SELECT * FROM task_progress WHERE user_id = $1', [userId]);
        const progressMap = {};
        progressRows.forEach(p => { progressMap[p.task_id] = p; });

        const videoIds = progressRows.filter(p => p.current_video_id).map(p => p.current_video_id);
        let videoMap = {};
        if (videoIds.length) {
            const { rows: vids } = await pool.query(
                `SELECT id, url, title FROM videos WHERE id = ANY($1::int[])`, [videoIds]
            );
            vids.forEach(v => { videoMap[v.id] = v; });
        }

        const tasksWithStatus = taskRows.map(task => {
            const p = progressMap[task.id];
            const currentVideo = p && p.current_video_id ? videoMap[p.current_video_id] : null;
            const effectiveStatus = computeEffectiveStatus(task, p);

            let renewsOn = null;
            if (p && p.status === 'completed' && task.renew_after_days && task.renew_after_days > 0 && p.completed_at) {
                const renewDate = new Date(new Date(p.completed_at).getTime() + task.renew_after_days * 24 * 60 * 60 * 1000);
                renewsOn = renewDate.toISOString();
            }

            return {
                id: task.id,
                title: task.title,
                description: task.description,
                reward: task.reward,
                category: task.category,
                link: task.link,
                instructions: task.instructions,
                verification: task.verification,
                minSeconds: task.min_seconds,
                repeatable: task.repeatable,
                renewAfterDays: task.renew_after_days,
                status: effectiveStatus,
                startedAt: p ? p.started_at : null,
                completedAt: p ? p.completed_at : null,
                renewsOn: renewsOn,
                adminNote: p ? p.admin_note : null,
                currentVideo: currentVideo
                    ? { id: currentVideo.id, url: currentVideo.url, title: currentVideo.title }
                    : null
            };
        });

        const cooldown = await getCooldownRemaining(userId);

        res.json({
            tasks: tasksWithStatus,
            cooldownRemaining: cooldown,
            cooldownTotal: TASK_COOLDOWN_SECONDS
        });
    } catch (err) {
        console.error('Tasks error:', err);
        res.status(500).json({ error: 'Failed to load tasks' });
    }
});

app.post('/api/tasks/start', async (req, res) => {
    const { userId, taskId } = req.body;
    try {
        const user = await findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const remaining = await getCooldownRemaining(userId);
        if (remaining > 0) {
            return res.status(429).json({
                error: `Please wait ${remaining}s before starting another task.`,
                cooldownRemaining: remaining
            });
        }

        const taskRes = await pool.query('SELECT * FROM tasks WHERE id = $1 AND active = TRUE', [taskId]);
        const task = taskRes.rows[0];
        if (!task) return res.status(404).json({ error: 'Task not found' });

        let { rows } = await pool.query(
            'SELECT * FROM task_progress WHERE user_id = $1 AND task_id = $2', [userId, taskId]
        );
        let progress = rows[0];
        if (!progress) {
            const ins = await pool.query(
                `INSERT INTO task_progress (user_id, task_id, status) VALUES ($1,$2,'available') RETURNING *`,
                [userId, taskId]
            );
            progress = ins.rows[0];
        }

        if (progress.status === 'pending') {
            return res.status(400).json({ error: 'Task awaiting admin approval' });
        }

        const effectiveStatus = computeEffectiveStatus(task, progress);
        if (effectiveStatus === 'completed') {
            return res.status(400).json({ error: 'Task not yet renewable. Check back later.' });
        }

        if (progress.status === 'started') {
            let existingVideo = null;
            if (progress.current_video_id) {
                const vRes = await pool.query('SELECT id, url, title FROM videos WHERE id = $1', [progress.current_video_id]);
                existingVideo = vRes.rows[0] || null;
            }
            return res.json({
                message: 'Task already started',
                startedAt: progress.started_at,
                minSeconds: task.min_seconds,
                video: existingVideo
            });
        }

        let video = null;
        if (task.verification === 'video') {
            video = await pickRandomVideoForUser(userId);
            if (!video) {
                return res.status(503).json({ error: 'No videos available right now. Try again later.' });
            }
        }

        const update = await pool.query(
            `UPDATE task_progress
             SET status = 'started', started_at = NOW(), current_video_id = $1
             WHERE user_id = $2 AND task_id = $3 RETURNING *`,
            [video ? video.id : null, userId, taskId]
        );

        res.json({
            message: 'Task started',
            startedAt: update.rows[0].started_at,
            minSeconds: task.min_seconds,
            video: video ? { id: video.id, url: video.url, title: video.title } : null
        });
    } catch (err) {
        console.error('Task start error:', err);
        res.status(500).json({ error: 'Failed to start task' });
    }
});

app.post('/api/tasks/complete', async (req, res) => {
    const { userId, taskId, proofUrl, videoId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

        const taskRes = await client.query('SELECT * FROM tasks WHERE id = $1 AND active = TRUE', [taskId]);
        const task = taskRes.rows[0];
        if (!task) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found' }); }

        const progressRes = await client.query(
            'SELECT * FROM task_progress WHERE user_id = $1 AND task_id = $2', [userId, taskId]
        );
        const progress = progressRes.rows[0];
        if (!progress) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found for user' }); }

        if (progress.status === 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Task awaiting admin approval' });
        }

        if (progress.status !== 'started' || !progress.started_at) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'You must start this task first' });
        }

        const recentCount = await getRecentCompletionCount(userId);
        if (recentCount >= RATE_LIMIT_PER_HOUR) {
            await client.query('ROLLBACK');
            return res.status(429).json({ error: `Too many completions. Max ${RATE_LIMIT_PER_HOUR}/hour.` });
        }

        if (task.min_seconds > 0) {
            const elapsed = (Date.now() - new Date(progress.started_at).getTime()) / 1000;
            if (elapsed < task.min_seconds) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `Please spend at least ${task.min_seconds}s on this task. You've only done ${Math.floor(elapsed)}s.`
                });
            }
        }

        let usedVideoId = null;
        if (task.verification === 'video') {
            let vid = null;
            if (videoId) {
                const check = await client.query('SELECT id FROM videos WHERE id = $1 AND active = TRUE', [videoId]);
                if (check.rows.length) vid = check.rows[0].id;
            }
            if (!vid && progress.current_video_id) vid = progress.current_video_id;
            if (!vid) {
                const fallback = await client.query(
                    `SELECT id FROM videos WHERE active = TRUE AND id NOT IN (SELECT video_id FROM user_videos WHERE user_id = $1) ORDER BY RANDOM() LIMIT 1`,
                    [userId]
                );
                if (fallback.rows.length) vid = fallback.rows[0].id;
            }
            if (!vid) {
                const any = await client.query(`SELECT id FROM videos WHERE active = TRUE ORDER BY RANDOM() LIMIT 1`);
                if (any.rows.length) vid = any.rows[0].id;
            }
            if (!vid) {
                await client.query('ROLLBACK');
                return res.status(503).json({ error: 'No videos available. Try again later.' });
            }
            usedVideoId = vid;
            await client.query(
                `INSERT INTO user_videos (user_id, video_id, task_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, video_id) DO NOTHING`,
                [userId, vid, taskId]
            );
        }

        if (task.verification === 'proof' || task.verification === 'admin') {
            if (!proofUrl || typeof proofUrl !== 'string' || proofUrl.trim().length < 10) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Please provide proof to submit this task' });
            }
            await client.query(
                `UPDATE task_progress SET status = 'pending', proof_url = $1, completed_at = NOW(), current_video_id = NULL
                 WHERE user_id = $2 AND task_id = $3`,
                [proofUrl.trim(), userId, taskId]
            );
            await client.query(`UPDATE users SET pending_balance = pending_balance + $1 WHERE id = $2`, [task.reward, userId]);
            await client.query('COMMIT');
            return res.json({
                message: 'Submitted for review. Reward will be credited after approval.',
                pending: true, reward: task.reward
            });
        }

        await client.query(
            `INSERT INTO task_completions (user_id, task_id, reward, video_id) VALUES ($1, $2, $3, $4)`,
            [userId, taskId, task.reward, usedVideoId]
        );

        if (task.repeatable) {
            await client.query(
                `UPDATE task_progress SET status = 'available', started_at = NULL, completed_at = NOW(), current_video_id = NULL
                 WHERE user_id = $1 AND task_id = $2`,
                [userId, taskId]
            );
        } else {
            await client.query(
                `UPDATE task_progress SET status = 'completed', completed_at = NOW(), current_video_id = NULL
                 WHERE user_id = $1 AND task_id = $2`,
                [userId, taskId]
            );
        }

        const updated = await client.query(
            `UPDATE users SET balance = balance + $1, tasks_completed = tasks_completed + 1 WHERE id = $2 RETURNING balance`,
            [task.reward, userId]
        );

        await client.query('COMMIT');
        res.json({
            message: 'Task completed!',
            reward: task.reward,
            newBalance: updated.rows[0].balance,
            cooldownRemaining: TASK_COOLDOWN_SECONDS,
            repeatable: task.repeatable
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Task complete error:', err);
        res.status(500).json({ error: 'Failed to complete task' });
    } finally { client.release(); }
});

// ==================== TRANSFERS ====================

app.get('/api/withdraw/window', (req, res) => {
    const open = isTransferWindowOpen();
    const next = nextTransferWindowStart();
    res.json({
        open, nextWindow: next.toISOString(), nextWindowLabel: formatWindowDate(next),
        windowStartDay: TRANSFER_WINDOW_START_DAY, windowEndDay: TRANSFER_WINDOW_END_DAY,
        minTransfer: MIN_TRANSFER
    });
});

app.post('/api/withdraw/start', async (req, res) => {
    const { userId } = req.body;
    if (!isTransferWindowOpen()) {
        const next = nextTransferWindowStart();
        return res.status(403).json({
            error: `Transfers are only available from the ${TRANSFER_WINDOW_START_DAY}th to the ${TRANSFER_WINDOW_END_DAY}th of each month. Next window opens on ${formatWindowDate(next)}.`
        });
    }
    try {
        const user = await findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await pool.query(
            `INSERT INTO withdraw_starts (user_id, started_at) VALUES ($1, NOW())
             ON CONFLICT (user_id) DO UPDATE SET started_at = NOW()`,
            [userId]
        );
        res.json({ ok: true, minSeconds: 600 });
    } catch { res.status(500).json({ error: 'Failed to start transfer session' }); }
});

app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, bankName, accountNumber } = req.body;
    if (!isTransferWindowOpen()) {
        const next = nextTransferWindowStart();
        return res.status(403).json({
            error: `Transfers are only available from the ${TRANSFER_WINDOW_START_DAY}th to the ${TRANSFER_WINDOW_END_DAY}th of each month. Next window opens on ${formatWindowDate(next)}.`
        });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

        const startRes = await client.query('SELECT started_at FROM withdraw_starts WHERE user_id = $1', [userId]);
        const startedAt = startRes.rows[0]?.started_at;
        if (!startedAt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Transfer session not started' }); }
        const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
        if (elapsed < 600) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `You must watch the ad for ${Math.ceil(600 - elapsed)}s more.` });
        }

        const amt = parseInt(amount);
        if (!amt || amt < MIN_TRANSFER) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Minimum transfer is ₦${MIN_TRANSFER.toLocaleString()}` }); }
        if (user.balance < amt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }
        if (!bankName || typeof bankName !== 'string') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bank name is required' }); }
        if (!/^\d{10}$/.test(accountNumber)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Account number must be 10 digits' }); }

        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amt, userId]);
        await client.query(
            `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, status) VALUES ($1,$2,$3,$4,'processing')`,
            [userId, amt, bankName, accountNumber]
        );
        await client.query('DELETE FROM withdraw_starts WHERE user_id = $1', [userId]);
        const bal = await client.query('SELECT balance FROM users WHERE id = $1', [userId]);

        await client.query('COMMIT');
        res.json({ message: 'Transfer request submitted!', amount: amt, newBalance: bal.rows[0].balance, bankName, accountNumber });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Withdraw error:', err);
        res.status(500).json({ error: 'Transfer failed. Try again.' });
    } finally { client.release(); }
});

app.get('/api/withdrawals/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
        const user = await findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const { rows } = await pool.query(
            `SELECT id, amount, bank_name, account_number, status, requested_at, processed_at
             FROM withdrawals WHERE user_id = $1 ORDER BY requested_at DESC`,
            [userId]
        );
        res.json(rows.map(r => ({
            id: r.id, amount: r.amount, bankName: r.bank_name, accountNumber: r.account_number,
            status: r.status, requestedAt: r.requested_at, processedAt: r.processed_at
        })));
    } catch { res.status(500).json({ error: 'Failed to load history' }); }
});

// ==================== CPX ====================

app.get('/api/cpx-hash/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    try {
        const user = await findUserById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!process.env.CPX_SECURE_HASH) return res.status(500).json({ error: 'CPX hash not configured' });

        const hash = crypto.createHash('md5').update(`${userId}-${process.env.CPX_SECURE_HASH}`).digest('hex');

        res.json({
            appId: process.env.CPX_APP_ID,
            userId: user.id,
            username: user.username,
            email: user.email || user.phone,
            hash
        });
    } catch { res.status(500).json({ error: 'Failed to generate hash' }); }
});

app.all('/api/cpx-webhook', async (req, res) => {
    const params = { ...req.query, ...req.body };
    const { status, trans_id, user_id, amount_local, hash } = params;
    console.log('CPX webhook:', params);

    if (!trans_id || !user_id) return res.status(400).json({ error: 'Missing trans_id or user_id' });

    if (process.env.CPX_SECURE_HASH && hash) {
        const wd = crypto.createHash('md5').update(`${trans_id}-${process.env.CPX_SECURE_HASH}`).digest('hex');
        const nd = crypto.createHash('md5').update(`${trans_id}${process.env.CPX_SECURE_HASH}`).digest('hex');
        if (hash !== wd && hash !== nd) return res.status(403).json({ error: 'Invalid hash' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const uRes = await client.query('SELECT * FROM users WHERE id = $1', [user_id]);
        const user = uRes.rows[0];
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

        const reward = Math.round(parseFloat(amount_local || '0') || 0);

        if (String(status) === '2') {
            const tx = await client.query('SELECT * FROM cpx_transactions WHERE trans_id = $1', [trans_id]);
            if (tx.rows[0] && !tx.rows[0].reversed) {
                await client.query(
                    'UPDATE users SET balance = GREATEST(0, balance - $1), tasks_completed = GREATEST(0, tasks_completed - 1) WHERE id = $2',
                    [tx.rows[0].amount, user_id]
                );
                await client.query('UPDATE cpx_transactions SET reversed = TRUE WHERE trans_id = $1', [trans_id]);
            }
            await client.query('COMMIT');
            return res.json({ ok: true, reversed: true });
        }

        if (String(status) !== '1') { await client.query('ROLLBACK'); return res.json({ ok: true }); }

        const dup = await client.query('SELECT id FROM cpx_transactions WHERE trans_id = $1', [trans_id]);
        if (dup.rows.length) { await client.query('ROLLBACK'); return res.json({ ok: true, message: 'Already processed' }); }

        await client.query(
            `INSERT INTO cpx_transactions (trans_id, user_id, amount) VALUES ($1,$2,$3)`,
            [trans_id, user_id, reward]
        );
        await client.query(
            'UPDATE users SET balance = balance + $1, tasks_completed = tasks_completed + 1 WHERE id = $2',
            [reward, user_id]
        );
        await client.query('COMMIT');
        res.json({ ok: true, credited: reward });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('CPX error:', err);
        res.status(500).json({ error: 'Webhook processing failed' });
    } finally { client.release(); }
});

// ==================== ADMIN AUTH ====================

function requireAdmin(req, res, next) {
    const pw = req.headers['x-admin-password'] || req.query.adminPassword || (req.body && req.body.adminPassword);
    if (!process.env.DATABASE_PASSWORD || pw !== process.env.DATABASE_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body;
    if (!process.env.DATABASE_PASSWORD || password !== process.env.DATABASE_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    res.json({ ok: true });
});

// Stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const [users, tasks, withdrawals, pending] = await Promise.all([
            pool.query('SELECT COUNT(*)::int AS c FROM users'),
            pool.query('SELECT COUNT(*)::int AS c FROM tasks WHERE active = TRUE'),
            pool.query('SELECT COUNT(*)::int AS c FROM withdrawals'),
            pool.query(`SELECT COUNT(*)::int AS c FROM task_progress WHERE status = 'pending'`)
        ]);
        const bal = await pool.query('SELECT COALESCE(SUM(balance),0)::int AS total FROM users');

        res.json({
            users: users.rows[0].c,
            activeTasks: tasks.rows[0].c,
            withdrawals: withdrawals.rows[0].c,
            pendingReviews: pending.rows[0].c,
            totalBalances: bal.rows[0].total
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// ==================== ADMIN: USERS ====================

app.get('/api/admin/panel/users', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
        res.json(rows.map(sanitizeUser));
    } catch { res.status(500).json({ error: 'Failed to load users' }); }
});

app.patch('/api/admin/panel/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { balance, pending_balance, tasks_completed, username } = req.body;

    const fields = [];
    const values = [];
    let i = 1;

    if (typeof balance === 'number') { fields.push(`balance = $${i++}`); values.push(balance); }
    if (typeof pending_balance === 'number') { fields.push(`pending_balance = $${i++}`); values.push(pending_balance); }
    if (typeof tasks_completed === 'number') { fields.push(`tasks_completed = $${i++}`); values.push(tasks_completed); }
    if (typeof username === 'string' && username.length >= 3) { fields.push(`username = $${i++}`); values.push(username); }

    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

    values.push(id);
    try {
        const { rows } = await pool.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
            values
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json(sanitizeUser(rows[0]));
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

app.delete('/api/admin/panel/users/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Failed to delete user' }); }
});

// ==================== ADMIN: TASKS ====================

app.get('/api/admin/panel/tasks', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM tasks ORDER BY id');
        res.json(rows);
    } catch { res.status(500).json({ error: 'Failed to load tasks' }); }
});

app.patch('/api/admin/panel/tasks/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const allowed = ['title', 'description', 'reward', 'category', 'link', 'instructions', 'verification', 'min_seconds', 'active', 'repeatable', 'renew_after_days'];

    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            fields.push(`${key} = $${i++}`);
            values.push(req.body[key]);
        }
    }
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

    values.push(id);
    try {
        const { rows } = await pool.query(
            `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
            values
        );
        if (!rows.length) return res.status(404).json({ error: 'Task not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Update task error:', err);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// ==================== ADMIN: WITHDRAWALS ====================

app.get('/api/admin/panel/withdrawals', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT w.*, u.username, u.email, u.phone
             FROM withdrawals w
             JOIN users u ON u.id = w.user_id
             ORDER BY w.requested_at DESC`
        );
        res.json(rows);
    } catch { res.status(500).json({ error: 'Failed to load withdrawals' }); }
});

// ==================== ADMIN: VIDEOS ====================

app.get('/api/admin/panel/videos', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM videos ORDER BY id DESC');
        res.json(rows);
    } catch { res.status(500).json({ error: 'Failed to load videos' }); }
});

app.post('/api/admin/panel/videos', requireAdmin, async (req, res) => {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO videos (url, title) VALUES ($1, $2) RETURNING *`,
            [url, title || null]
        );
        res.json(rows[0]);
    } catch { res.status(500).json({ error: 'Failed to add video' }); }
});

app.delete('/api/admin/panel/videos/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM videos WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Failed to delete video' }); }
});

// ==================== ADMIN: COMPLETIONS ====================

app.get('/api/admin/panel/completions', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT tc.*, u.username, t.title AS task_title
             FROM task_completions tc
             JOIN users u ON u.id = tc.user_id
             JOIN tasks t ON t.id = tc.task_id
             ORDER BY tc.completed_at DESC
             LIMIT 200`
        );
        res.json(rows);
    } catch { res.status(500).json({ error: 'Failed to load completions' }); }
});

// ==================== ADMIN (legacy — kept for compatibility) ====================

app.get('/api/admin/pending', async (req, res) => {
    if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { rows } = await pool.query(
            `SELECT tp.user_id, tp.task_id, tp.proof_url, tp.completed_at,
                    u.username, u.email, u.phone, t.title AS task_title, t.reward
             FROM task_progress tp
             JOIN users u ON u.id = tp.user_id
             JOIN tasks t ON t.id = tp.task_id
             WHERE tp.status = 'pending'
             ORDER BY tp.completed_at DESC`
        );
        res.json(rows.map(r => ({
            userId: r.user_id, username: r.username, email: r.email, phone: r.phone,
            taskId: r.task_id, taskTitle: r.task_title, reward: r.reward,
            proofUrl: r.proof_url, submittedAt: r.completed_at
        })));
    } catch { res.status(500).json({ error: 'Failed to load pending' }); }
});

app.post('/api/admin/review', async (req, res) => {
    const { adminKey, userId, taskId, approve, note } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tRes = await client.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
        const task = tRes.rows[0];
        if (!task) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found' }); }

        const pRes = await client.query(
            `SELECT * FROM task_progress WHERE user_id = $1 AND task_id = $2 AND status = 'pending'`,
            [userId, taskId]
        );
        if (!pRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No pending submission' }); }

        await client.query('UPDATE users SET pending_balance = GREATEST(0, pending_balance - $1) WHERE id = $2', [task.reward, userId]);

        if (approve) {
            const finalStatus = task.repeatable ? 'available' : 'completed';

            await client.query(
                `UPDATE task_progress SET status = $1, admin_note = $2, completed_at = NOW()
                 WHERE user_id = $3 AND task_id = $4`,
                [finalStatus, note || null, userId, taskId]
            );

            await client.query(
                `INSERT INTO task_completions (user_id, task_id, reward) VALUES ($1, $2, $3)`,
                [userId, taskId, task.reward]
            );

            const u = await client.query(
                `UPDATE users SET balance = balance + $1, tasks_completed = tasks_completed + 1 WHERE id = $2 RETURNING *`,
                [task.reward, userId]
            );
            await client.query('COMMIT');
            return res.json({
                message: 'Approved', userId, taskId, reward: task.reward,
                newBalance: u.rows[0].balance, newPendingBalance: u.rows[0].pending_balance
            });
        } else {
            await client.query(
                `UPDATE task_progress SET status = 'rejected', admin_note = $1, proof_url = NULL WHERE user_id = $2 AND task_id = $3`,
                [note || 'Proof insufficient', userId, taskId]
            );
            const u = await client.query('SELECT pending_balance FROM users WHERE id = $1', [userId]);
            await client.query('COMMIT');
            return res.json({ message: 'Rejected', userId, taskId, note: note || 'Proof insufficient', newPendingBalance: u.rows[0].pending_balance });
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Review error:', err);
        res.status(500).json({ error: 'Review failed' });
    } finally { client.release(); }
});

app.get('/api/admin/users', async (req, res) => {
    if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
        res.json(rows.map(sanitizeUser));
    } catch { res.status(500).json({ error: 'Failed to load users' }); }
});

app.post('/api/admin/transfer', async (req, res) => {
    const { adminKey, adminPassword, transferId, status, note } = req.body;

    // Accept either ADMIN_KEY (old) or DATABASE_PASSWORD (new admin panel)
    const okKey = adminKey === process.env.ADMIN_KEY;
    const okPw = adminPassword && adminPassword === process.env.DATABASE_PASSWORD;
    if (!okKey && !okPw) return res.status(403).json({ error: 'Forbidden' });

    if (!['processing', 'paid', 'failed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tRes = await client.query('SELECT * FROM withdrawals WHERE id = $1', [transferId]);
        const transfer = tRes.rows[0];
        if (!transfer) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }

        await client.query(
            `UPDATE withdrawals SET status = $1, processed_at = NOW(), admin_note = $2 WHERE id = $3`,
            [status, note || null, transferId]
        );
        if (status === 'failed') {
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [transfer.amount, transfer.user_id]);
        }
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Transfer update failed' });
    } finally { client.release(); }
});

app.get('/api/admin/transfers', async (req, res) => {
    if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { rows } = await pool.query('SELECT * FROM withdrawals ORDER BY requested_at DESC');
        res.json(rows.map(r => ({
            id: r.id, userId: r.user_id, amount: r.amount, bankName: r.bank_name,
            accountNumber: r.account_number, status: r.status, requestedAt: r.requested_at,
            processedAt: r.processed_at, adminNote: r.admin_note
        })));
    } catch { res.status(500).json({ error: 'Failed to load transfers' }); }
});

app.post('/api/admin/videos', async (req, res) => {
    const { adminKey, url, title } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO videos (url, title) VALUES ($1, $2) RETURNING *`,
            [url, title || null]
        );
        res.json(rows[0]);
    } catch { res.status(500).json({ error: 'Failed to add video' }); }
});

app.get('/api/admin/videos', async (req, res) => {
    if (req.query.adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { rows } = await pool.query('SELECT * FROM videos ORDER BY id DESC');
        res.json(rows);
    } catch { res.status(500).json({ error: 'Failed to load videos' }); }
});

// ==================== HEALTH & START ====================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ ok: true, db: 'connected' });
    } catch (err) {
        res.status(500).json({ ok: false, db: 'error', error: err.message });
    }
});

async function start() {
    try {
        await initDb();
        app.listen(PORT, () => {
            console.log(`MannieNG running on ${PORT}`);
            console.log(`Transfer window: day ${TRANSFER_WINDOW_START_DAY}–${TRANSFER_WINDOW_END_DAY}`);
            console.log(`Min transfer: ₦${MIN_TRANSFER.toLocaleString()}`);
            console.log(`Cooldown: ${TASK_COOLDOWN_SECONDS}s`);
            console.log(`Referral: ₦${REFERRAL_BONUS_REFERRER} / ₦${REFERRAL_BONUS_NEW_USER}`);
            console.log(`Window currently: ${isTransferWindowOpen() ? 'OPEN ✅' : 'CLOSED ❌'}`);
            if (!process.env.DATABASE_PASSWORD) console.warn('⚠️  DATABASE_PASSWORD not set — /admin will not work');
        });
    } catch (err) {
        console.error('❌ Failed to start:', err);
        process.exit(1);
    }
}

start();