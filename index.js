const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const crypto = require('crypto');

const app = express();

// Use environment variable for frontend URL in production, or allow all for testing
const frontendUrl = process.env.FRONTEND_URL || "*";
app.use(cors({
    origin: frontendUrl,
    methods: ["GET", "POST"]
}));

app.use(express.json());

// Create 'uploads' folder if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Setup storage engine
// const storage = multer.diskStorage({
//     destination: (req, file, cb) => cb(null, 'uploads/'),
//     filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
// });
const storage = multer.memoryStorage();
const upload = multer({ storage });

const ALGORITHM = 'aes-256-cbc';

// Helper to encrypt a buffer
function encrypt(buffer, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const result = Buffer.concat([salt, iv, cipher.update(buffer), cipher.final()]);
    return result;
}

// Helper to decrypt a buffer
function decrypt(buffer, password) {
    const salt = buffer.slice(0, 16);
    const iv = buffer.slice(16, 32);
    const encryptedData = buffer.slice(32);
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    const result = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return result;
}

// Database to store keys and file paths
let fileDatabase = {};

// API to Upload
app.post('/upload', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send("No files uploaded.");
    
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    
    fileDatabase[key] = req.files.map(file => {
        const encryptedBuffer = encrypt(file.buffer, key);
        const fileName = Date.now() + '-' + file.originalname + '.enc';
        const filePath = path.join(uploadDir, fileName);
        
        fs.writeFileSync(filePath, encryptedBuffer);
        
        return {
            path: filePath,
            name: file.originalname
        };
    });
    
    res.json({ key, count: req.files.length });
});

// API to Download
app.get('/download/:key', (req, res) => {
    const key = req.params.key;
    const files = fileDatabase[key];
    if (!files) return res.status(404).send("Invalid or expired key.");

    const fileIndex = req.query.index;

    // Single File Download
    if (fileIndex !== undefined) {
        const file = files[parseInt(fileIndex)];
        if (!file) return res.status(404).send("File not found.");
        
        const encryptedBuffer = fs.readFileSync(file.path);
        const decryptedBuffer = decrypt(encryptedBuffer, key);
        
        res.setHeader('Content-Disposition', `attachment; filename=${file.name}`);
        return res.send(decryptedBuffer);
    }

    // ZIP Download
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`ShareIt-${key}.zip`);
    archive.pipe(res);

    files.forEach(file => {
        const encryptedBuffer = fs.readFileSync(file.path);
        const decryptedBuffer = decrypt(encryptedBuffer, key);
        archive.append(decryptedBuffer, { name: file.name });
    });

    archive.finalize();
});

// API: Get file metadata
app.get('/metadata/:key', (req, res) => {
    const files = fileDatabase[req.params.key];
    if (!files) return res.status(404).send("Invalid key.");
    
    const meta = files.map((f, index) => ({ name: f.name, index }));
    res.json({ files: meta });
});

// Use Render's dynamic port
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
