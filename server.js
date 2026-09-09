const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'mannieng_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// In-memory database (replace with MongoDB/PostgreSQL for production)
const users = [];
const tasks = [];
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

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname,'register.html'));
});

// API Routes
app.post('/api/register', async (req, res) => {
    const { username, email, password, phone } = req.body;
    
    // Validate Nigerian phone number
    const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ error: 'Invalid Nigerian phone number' });
    }

    // Check if user exists
    if (users.find(u => u.email === email || u.username === username)) {
        return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
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
    
    // Initialize task progress for user
    sampleTasks.forEach(task => {
        taskProgress.push({
            userId: user.id,
            taskId: task.id,
            completed: false,
            startedAt: null,
            completedAt: null
        });
    });
    
    req.session.userId = user.id;
    req.session.username = user.username;
    
    res.status(201).json({ 
        message: 'Registration successful!', 
        user: { 
            id: user.id, 
            username: user.username, 
            email: user.email,
            referralCode: user.referralCode 
        } 
    });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    const user = users.find(u => u.email === email);
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.userId = user.id;
    req.session.username = user.username;
    
    res.json({ 
        message: 'Login successful!', 
        user: { 
            id: user.id, 
            username: user.username, 
            email: user.email,
            balance: user.balance,
            referralCode: user.referralCode
        } 
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out successfully' });
});

app.get('/api/tasks', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const userId = req.session.userId;
    const userTasks = taskProgress.filter(tp => tp.userId === userId);
    
    const tasksWithStatus = sampleTasks.map(task => {
        const progress = userTasks.find(tp => tp.taskId === task.id);
        return {
            ...task,
            completed: progress ? progress.completed : false,
            progress: progress || null
        };
    });
    
    res.json(tasksWithStatus);
});

app.post('/api/tasks/:taskId/complete', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const userId = req.session.userId;
    const taskId = parseInt(req.params.taskId);
    
    // Find task progress
    const progress = taskProgress.find(tp => tp.userId === userId && tp.taskId === taskId);
    if (!progress) {
        return res.status(404).json({ error: 'Task not found' });
    }
    
    if (progress.completed) {
        return res.status(400).json({ error: 'Task already completed' });
    }
    
    // Find task
    const task = sampleTasks.find(t => t.id === taskId);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    
    // Update progress
    progress.completed = true;
    progress.completedAt = new Date().toISOString();
    
    // Update user balance
    const user = users.find(u => u.id === userId);
    if (user) {
        user.balance += task.reward;
        user.tasksCompleted += 1;
    }
    
    res.json({ 
        message: 'Task completed successfully!', 
        reward: task.reward,
        newBalance: user.balance
    });
});

app.get('/api/user/profile', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const user = users.find(u => u.id === req.session.userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    const { password, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
});

app.post('/api/withdraw', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { amount, bankName, accountNumber } = req.body;
    const user = users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    if (amount < 100) {
        return res.status(400).json({ error: 'Minimum withdrawal is ₦100' });
    }
    
    // Process withdrawal (in production, integrate with Flutterwave or Paystack)
    user.balance -= amount;
    
    res.json({ 
        message: 'Withdrawal request submitted!', 
        amount: amount,
        newBalance: user.balance,
        bankName,
        accountNumber
    });
});

app.listen(PORT, () => {
    console.log(`MannieNG server running on port ${PORT}`);
});
