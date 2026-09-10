const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory storage (swap for MongoDB/Postgres in production)
const users = [];
const taskProgress = [];

// Sample tasks for Nigerian users
const sampleTasks = [
    {
        id: 1,
        title: 'Watch YouTube Video',
        description: 'Watch a 2-minute video about Nigerian culture',
        reward: 50,
        category: 'Video',
        link: 'https://youtube.com/watch?v=example1',
        instructions: 'Watch the full video and confirm completion'
    },
    {
        id: 2,
        title: 'Complete Survey',
        description: 'Share your opinion about fintech in Nigeria',
        reward: 100,
        category: 'Survey',
        link: 'https://survey.example.com',
        instructions: 'Answer all questions honestly'
    },
    {
        id: 3,
        title: 'Download App',
        description: 'Download and install a Nigerian shopping app',
        reward: 150,
        category: 'Download',
        link: 'https://play.google.com/store/apps/details?id=example',
        instructions: 'Download, install and open the app'
    },
    {
        id: 4,
        title: 'Refer a Friend',
        description: 'Refer a friend to MannieNG and earn rewards',
        reward: 200,
        category: 'Referral',
        link: '',
        instructions: 'Share your referral link with friends'
    },
    {
        id: 5,
        title: 'Social Media Post',
        description: 'Post about MannieNG on Instagram or Twitter',
        reward: 75,
        category: 'Social',
        link: '',
        instructions: 'Post using #MannieNG and tag @MannieNG'
    }
];

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
    const { username, email, password, phone } = req.body;

    if (!username || !email || !password || !phone) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ error: 'Invalid Nigerian phone number' });
    }

    if (users.find(u => u.email === email || u.username === username)) {
        return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = {
        id: users.length + 1,
        username,
        email,
        password: hashedPassword,
        phone,
        balance: 0,
        tasksCompleted: 0,
        referralCode: `MNG${Date.now().toString(36).toUpperCase()}`,
        createdAt: new Date().toISOString()
    };

    users.push(user);

    sampleTasks.forEach(task => {
        taskProgress.push({
            userId: user.id,
            taskId: task.id,
            completed: false,
            completedAt: null
        });
    });

    const { password: _, ...safeUser } = user;
    res.status(201).json({ message: 'Registration successful!', user: safeUser });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _, ...safeUser } = user;
    res.json({ message: 'Login successful!', user: safeUser });
});

// ---------- User ----------
app.get('/api/user/:id', (req, res) => {
    const user = users.find(u => u.id === parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { password, ...safeUser } = user;
    res.json(safeUser);
});

// ---------- Tasks ----------
app.get('/api/tasks/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tasksWithStatus = sampleTasks.map(task => {
        const progress = taskProgress.find(tp => tp.userId === userId && tp.taskId === task.id);
        return { ...task, completed: progress ? progress.completed : false };
    });

    res.json(tasksWithStatus);
});

app.post('/api/tasks/complete', (req, res) => {
    const { userId, taskId } = req.body;

    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const progress = taskProgress.find(tp => tp.userId === userId && tp.taskId === taskId);
    if (!progress) return res.status(404).json({ error: 'Task not found' });

    if (progress.completed) return res.status(400).json({ error: 'Task already completed' });

    const task = sampleTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    progress.completed = true;
    progress.completedAt = new Date().toISOString();

    user.balance += task.reward;
    user.tasksCompleted += 1;

    res.json({
        message: 'Task completed successfully!',
        reward: task.reward,
        newBalance: user.balance
    });
});

// ---------- Withdraw ----------
app.post('/api/withdraw', (req, res) => {
    const { userId, amount, bankName, accountNumber } = req.body;

    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is ₦100' });
    if (!/^\d{10}$/.test(accountNumber)) return res.status(400).json({ error: 'Invalid account number' });

    // TODO: integrate Flutterwave / Paystack here
    user.balance -= amount;

    res.json({
        message: 'Withdrawal request submitted!',
        amount,
        newBalance: user.balance,
        bankName,
        accountNumber
    });
});

app.listen(PORT, () => {
    console.log(`MannieNG server running on port ${PORT}`);
});