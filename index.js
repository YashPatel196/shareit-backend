const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
app.use(cors()); // Allows React to talk to this server
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
    
    // Generate 6-digit key
    const key = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store an array of file metadata
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

    // Option 1: Manually download one by one (if index is provided)
    if (fileIndex !== undefined) {
        const file = files[parseInt(fileIndex)];
        if (!file) return res.status(404).send("File not found.");
        return res.download(file.path, file.name);
    }

    // Option 2: Download All as ZIP (default behavior)
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`ShareIt-${req.params.key}.zip`);
    
    archive.on('error', (err) => res.status(500).send({ error: err.message }));
    archive.pipe(res);

    files.forEach(file => {
        archive.file(file.path, { name: file.name });
    });

    archive.finalize();
});

// New API: Get file metadata (to show the list on frontend)
app.get('/metadata/:key', (req, res) => {
    console.log("Current Database Keys:", Object.keys(fileDatabase));
    console.log("Requested Key:", req.params.key);
    const files = fileDatabase[req.params.key];
    if (!files) return res.status(404).send("Invalid key.");
    
    // Send only names and sizes, not paths
    const meta = files.map((f, index) => ({ name: f.name, index }));
    res.json({ files: meta });
});

const PORT = process.env.PORT || 5000;

// Update CORS to allow your future Vercel URL
app.use(cors({
    origin: process.env.FRONTEND_URL || "*", 
    methods: ["GET", "POST"]
}));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});