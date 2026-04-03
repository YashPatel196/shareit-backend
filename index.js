const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const crypto = require('crypto');
const mime = require('mime-types');

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

// Text-to-Key
app.post('/upload-text', (req, res) => {
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    fileDatabase[key] = { type: 'text', data: req.body.text };
    res.json({ key });
});

// Request Files Slot
app.get('/request-files', (req, res) => {
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    fileDatabase[key] = { type: 'files', data: [], isRequest: true };
    res.json({ key });
});

// Unified Metadata
app.get('/metadata/:key', (req, res) => {
    const entry = fileDatabase[req.params.key];
    if (!entry) return res.status(404).send("Invalid key.");
    if (entry.type === 'text') return res.json({ type: 'text', content: entry.data });
    
    const meta = entry.data.map((f, index) => ({ name: f.name, index }));
    res.json({ type: 'files', files: meta, isRequest: entry.isRequest });
});

// Upload (Supports normal & Request mode)
app.post('/upload', upload.array('files'), (req, res) => {
    let key = req.body.key || Math.floor(100000 + Math.random() * 900000).toString();
    const uploadedFiles = req.files.map(file => {
        const encrypted = encrypt(file.buffer, key);
        const fileName = `${Date.now()}-${file.originalname}.enc`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, encrypted);
        return { path: filePath, name: file.originalname };
    });
    fileDatabase[key] = { type: 'files', data: uploadedFiles, isRequest: false };
    res.json({ key });
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
    res.attachment(`ShareIt-${key}.zip`);
    archive.pipe(res);

    files.forEach(file => {
        const encryptedBuffer = fs.readFileSync(file.path);
        const decryptedBuffer = decrypt(encryptedBuffer, key);
        archive.append(decryptedBuffer, { name: file.name });
    });

    archive.finalize();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
