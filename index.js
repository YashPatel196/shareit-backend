const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const crypto = require('crypto');
const mime = require('mime-types');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

require('dotenv').config();
const JWT_SECRET = process.env.JWT_SECRET; //|| "fallback_secret_for_dev_only"; // In production, use process.env.JWT_SECRET
const USERS_FILE = path.join(__dirname, 'users.json');

const performSecurityScan = (files) => {
    // Simulate a 1.5 second scan
    const results = files.map(f => ({
        name: f.originalname,
        status: 'clean', // In a real app, logic goes here
        threats: 0
    }));
    return results;
};

// Helper to load/save users
const getUsers = () => {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
    return JSON.parse(fs.readFileSync(USERS_FILE));
};
const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const app = express();
const frontendUrl = process.env.FRONTEND_URL || "*";

app.use(cors({ origin: frontendUrl, methods: ["GET", "POST"] }));
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.memoryStorage();
const upload = multer({ storage });

const ALGORITHM = 'aes-256-cbc';

function encrypt(buffer, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    return Buffer.concat([salt, iv, cipher.update(buffer), cipher.final()]);
}

function decrypt(buffer, password) {
    const salt = buffer.slice(0, 16);
    const iv = buffer.slice(16, 32);
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    return Buffer.concat([decipher.update(buffer.slice(32)), decipher.final()]);
}

let fileDatabase = {};

// Register
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    const users = getUsers(); // Load from users.json
    
    if (!email || !password) return res.status(400).send("Missing credentials");
    if (users.find(u => u.email === email)) return res.status(400).send("User already exists");

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = { 
            id: Date.now(), 
            email, 
            password: hashedPassword 
        };
        
        users.push(newUser);
        saveUsers(users); // Save to users.json
        res.status(201).send("User created successfully");
    } catch (err) {
        res.status(500).send("Error creating user");
    }
});

// Login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.email === email);

    if (!user) return res.status(401).send("Invalid email or password");

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).send("Invalid email or password");

    // Create Token
    const token = jwt.sign(
        { userId: user.id, email: user.email }, 
        JWT_SECRET, 
        { expiresIn: '24h' }
    );
    
    res.json({ token, email: user.email });
});

// Text-to-Key
app.post('/upload-text', (req, res) => {
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    fileDatabase[key] = { type: 'text', data: req.body.text };
    res.json({ key });
});

// Unified Metadata
app.get('/metadata/:key', (req, res) => {
    const entry = fileDatabase[req.params.key];
    if (!entry) return res.status(404).send("Invalid key.");
    if (entry.type === 'text') return res.json({ type: 'text', content: entry.data });
    
    const meta = entry.data.map((f, index) => ({ 
        name: f.name, 
        index, 
        size: f.size
    }));
    res.json({ type: 'files', files: meta, isRequest: entry.isRequest });
});

// Upload (Supports normal & Request mode)
app.post('/upload', upload.array('files'), (req, res) => {
    let key = req.body.key || Math.floor(100000 + Math.random() * 900000).toString();
    
    // Fix: Map files and include index so download works
    try {
        const fileEntries = req.files.map((file, index) => {
            const encrypted = encrypt(file.buffer, key);
            const fileName = `${Date.now()}-${file.originalname}.enc`;
            const filePath = path.join(uploadDir, fileName);
            fs.writeFileSync(filePath, encrypted);
            
            return { 
                path: filePath, 
                name: file.originalname, 
                size: file.size,
                index: index // Crucial for the download/metadata logic
            };
        });

        fileDatabase[key] = {
            type: 'file',
            data: fileEntries,
            isPersistent: false,
            createdAt: new Date()
        };

        const scanResults = performSecurityScan(req.files);
    
        res.json({ 
            key, 
            scanResult: "Safe", 
            details: scanResults 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server file write error");
    }
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// Advanced Upload (Linked to User)
app.post('/advanced-upload', authenticateToken, upload.array('files'), (req, res) => {
    const { expirationHours } = req.body; // User selects duration (e.g., 1, 24, 168)
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDate = new Date(Date.now() + (parseInt(expirationHours) || 24) * 60 * 60 * 1000);
    
    const fileEntries = req.files.map((file, index) => {
        const filePath = path.join(uploadDir, `${key}-${index}`);
        fs.writeFileSync(filePath, encrypt(file.buffer, key));
        return { name: file.originalname, size: file.size, path: filePath, index };
    });

    fileDatabase[key] = {
        type: 'file',
        data: fileEntries,
        ownerId: req.user.userId, // <--- Links to the logged-in user
        isPersistent: true,       // <--- Won't be deleted by your cleanup task
        createdAt: new Date(),
        expiresAt: expiryDate
    };

    res.json({ key, expiresAt: expiryDate });
});

// Download
app.get('/download/:key', (req, res) => {
    const key = req.params.key;
    const entry = fileDatabase[key]; // This is now an object {type, data, isRequest}
    
    if (!entry) return res.status(404).send("Invalid or expired key.");

    // IMPORTANT: Access the array inside 'data'
    const files = entry.data; 
    if (!files || files.length === 0) return res.status(404).send("No files found for this key.");

    const fileIndex = req.query.index;

    // Single File Download
    if (fileIndex !== undefined) {
        const file = files[parseInt(fileIndex)];
        if (!file) return res.status(404).send("Specific file not found.");
        
        const encryptedBuffer = fs.readFileSync(file.path);
        const decryptedBuffer = decrypt(encryptedBuffer, key);
        
        // Fix: Identify the file type so it opens correctly (e.g., PDF, PNG)
        const contentType = mime.lookup(file.name) || 'application/octet-stream';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
        return res.send(decryptedBuffer);
    }

    // ZIP Download
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`AirMove-${key}.zip`);
    archive.pipe(res);

    files.forEach(file => {
        const encryptedBuffer = fs.readFileSync(file.path);
        const decryptedBuffer = decrypt(encryptedBuffer, key);
        archive.append(decryptedBuffer, { name: file.name });
    });

    archive.finalize();
});

app.get('/user-history', authenticateToken, (req, res) => {
    const history = Object.keys(fileDatabase)
        .filter(key => String(fileDatabase[key].ownerId) === String(req.user.userId))
        .map(key => {
            const entry = fileDatabase[key];
            const isExpired = new Date() > new Date(entry.expiresAt);
            return {
                key,
                type: entry.type,
                createdAt: entry.createdAt,
                expiresAt: entry.expiresAt,
                status: isExpired ? 'Expired' : 'Active',
                fileCount: entry.data.length
            };
        });
    res.json(history);
});

setInterval(() => {
    console.log("Running periodic cleanup..."); // Optional: adds a log to your terminal
    const now = Date.now();
    for (const key in fileDatabase) {
        const entry = fileDatabase[key];
        
        // Safety check: ensure createdAt exists before calculating
        const createdAt = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;

        // Logic: Delete if NOT persistent AND older than 24 hours
        if (!entry.isPersistent && (now - createdAt > 24 * 60 * 60 * 1000)) {
            console.log(`Deleting expired key: ${key}`);
            
            if (Array.isArray(entry.data)) {
                entry.data.forEach(f => {
                    if (fs.existsSync(f.path)) {
                        fs.unlinkSync(f.path);
                    }
                });
            }
            delete fileDatabase[key];
        }
        if (entry.isPersistent && entry.expiresAt && now > new Date(entry.expiresAt).getTime()) {
            console.log(`Deleting expired persistent key: ${key}`);
            // Actually delete the files from the disk
            if (Array.isArray(entry.data)) {
                entry.data.forEach(f => {
                    if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
                });
            }
            delete fileDatabase[key]; // Remove from memory
        }
    }
}, 3600000); // Runs once every hour

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
