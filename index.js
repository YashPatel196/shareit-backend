const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

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
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({ storage });

// Database to store keys and file paths
let fileDatabase = {};

// API to Upload
app.post('/upload', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send("No files uploaded.");
    
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    
    fileDatabase[key] = req.files.map(file => ({
        path: file.path,
        name: file.originalname
    }));
    
    console.log(`${req.files.length} files stored with key: ${key}`);
    res.json({ key, count: req.files.length });
});

// API to Download
app.get('/download/:key', (req, res) => {
    const files = fileDatabase[req.params.key];
    if (!files || files.length === 0) return res.status(404).send("Invalid or expired key.");

    const fileIndex = req.query.index;

    if (fileIndex !== undefined) {
        const file = files[parseInt(fileIndex)];
        if (!file) return res.status(404).send("File not found.");
        return res.download(file.path, file.name);
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`ShareIt-${req.params.key}.zip`);
    
    archive.on('error', (err) => res.status(500).send({ error: err.message }));
    archive.pipe(res);

    files.forEach(file => {
        archive.file(file.path, { name: file.name });
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
