import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import WebTorrent from 'webtorrent';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const client = new WebTorrent();
const pausedTorrents = new Map();
const torrentMetadata = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
fs.ensureDirSync(downloadsDir);

// Utility functions
const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSec) => {
    return formatBytes(bytesPerSec) + '/s';
};

const sanitizePath = (str) => {
    return str.replace(/[\/\\?%*:|"<>]/g, '_');
};

const formatTime = (seconds) => {
    if (seconds === Infinity || isNaN(seconds)) return '∞';
    if (seconds < 60) return Math.floor(seconds) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
};

// Get torrent statistics
const getTorrentStats = (torrent) => {
    const progress = (torrent.progress * 100).toFixed(2);
    const peers = torrent.numPeers;
    const timeRemaining = torrent.timeRemaining;
    const ratio = torrent.ratio.toFixed(2);
    
    return {
        infoHash: torrent.infoHash,
        name: torrent.name,
        size: formatBytes(torrent.length),
        sizeBytes: torrent.length,
        downloaded: formatBytes(torrent.downloaded),
        downloadedBytes: torrent.downloaded,
        uploaded: formatBytes(torrent.uploaded),
        uploadedBytes: torrent.uploaded,
        downloadSpeed: formatSpeed(torrent.downloadSpeed),
        downloadSpeedBytes: torrent.downloadSpeed,
        uploadSpeed: formatSpeed(torrent.uploadSpeed),
        uploadSpeedBytes: torrent.uploadSpeed,
        progress: parseFloat(progress),
        peers: peers,
        ratio: ratio,
        timeRemaining: formatTime(timeRemaining / 1000),
        isPaused: pausedTorrents.has(torrent.infoHash),
        files: torrent.files.map(f => ({
            name: f.name,
            size: formatBytes(f.length),
            progress: (f.progress * 100).toFixed(2)
        }))
    };
};

// Broadcast torrent updates to all connected clients
const broadcastTorrentUpdates = () => {
    const torrents = client.torrents.map(getTorrentStats);
    const globalStats = {
        downloadSpeed: formatSpeed(client.downloadSpeed),
        uploadSpeed: formatSpeed(client.uploadSpeed),
        totalTorrents: client.torrents.length,
        downloadSpeedBytes: client.downloadSpeed,
        uploadSpeedBytes: client.uploadSpeed
    };
    
    io.emit('torrent-update', { torrents, global: globalStats });
};

// Start real-time updates when torrents are active
setInterval(() => {
    if (client.torrents.length > 0) {
        broadcastTorrentUpdates();
    }
}, 1000); // Update every second

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('✓ Client connected:', socket.id);
    
    // Send initial data
    broadcastTorrentUpdates();
    
    socket.on('disconnect', () => {
        console.log('✗ Client disconnected:', socket.id);
    });
});

// Routes
app.get('/', (req, res) => {
    const torrents = client.torrents.map(getTorrentStats);
    const totalTorrents = client.torrents.length;
    const globalDownloadSpeed = formatSpeed(client.downloadSpeed);
    const globalUploadSpeed = formatSpeed(client.uploadSpeed);
    
    res.render('index', { 
        torrents, 
        totalTorrents,
        globalDownloadSpeed,
        globalUploadSpeed
    });
});

app.post('/add', async (req, res) => {
    const { magnetURI } = req.body;
    
    if (!magnetURI) {
        return res.status(400).json({ 
            success: false, 
            message: 'Magnet URI is required' 
        });
    }

    try {
        client.add(magnetURI, { path: downloadsDir }, (torrent) => {
            console.log(`✓ Torrent added: ${torrent.name}`);
            
            torrentMetadata.set(torrent.infoHash, {
                addedAt: new Date(),
                status: 'downloading'
            });

            // Emit torrent added event
            io.emit('torrent-added', {
                infoHash: torrent.infoHash,
                name: torrent.name
            });

            torrent.on('download', () => {
                // Real-time updates handled by interval
            });

            torrent.on('done', async () => {
                console.log(`✓ Download complete: ${torrent.name}`);
                torrentMetadata.get(torrent.infoHash).status = 'completed';
                
                // Emit completion event
                io.emit('torrent-completed', {
                    infoHash: torrent.infoHash,
                    name: torrent.name
                });
            });

            torrent.on('error', (err) => {
                console.error(`✗ Error with torrent ${torrent.name}:`, err.message);
                torrentMetadata.get(torrent.infoHash).status = 'error';
                
                // Emit error event
                io.emit('torrent-error', {
                    infoHash: torrent.infoHash,
                    name: torrent.name,
                    error: err.message
                });
            });

            // Broadcast immediate update
            broadcastTorrentUpdates();
        });

        res.json({ 
            success: true, 
            message: 'Torrent added successfully' 
        });
    } catch (error) {
        console.error('Error adding torrent:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to add torrent' 
        });
    }
});

app.post('/pause/:infoHash', (req, res) => {
    const { infoHash } = req.params;
    const torrent = client.get(infoHash);

    if (!torrent) {
        return res.status(404).json({ 
            success: false, 
            message: 'Torrent not found' 
        });
    }

    // WebTorrent doesn't have pause(), so we deselect all files to stop downloading
    torrent.files.forEach(file => file.deselect());
    pausedTorrents.set(infoHash, true);
    
    // Broadcast update
    io.emit('torrent-paused', { infoHash, name: torrent.name });
    broadcastTorrentUpdates();
    
    res.json({ 
        success: true, 
        message: 'Torrent paused' 
    });
});

app.post('/resume/:infoHash', (req, res) => {
    const { infoHash } = req.params;
    const torrent = client.get(infoHash);

    if (!torrent) {
        return res.status(404).json({ 
            success: false, 
            message: 'Torrent not found' 
        });
    }

    // Resume by selecting all files again
    torrent.files.forEach(file => file.select());
    pausedTorrents.delete(infoHash);
    
    // Broadcast update
    io.emit('torrent-resumed', { infoHash, name: torrent.name });
    broadcastTorrentUpdates();
    
    res.json({ 
        success: true, 
        message: 'Torrent resumed' 
    });
});

app.delete('/remove/:infoHash', (req, res) => {
    const { infoHash } = req.params;
    const torrent = client.get(infoHash);

    if (!torrent) {
        return res.status(404).json({ 
            success: false, 
            message: 'Torrent not found' 
        });
    }

    const torrentName = torrent.name;

    torrent.destroy(() => {
        pausedTorrents.delete(infoHash);
        torrentMetadata.delete(infoHash);
        
        // Broadcast update
        io.emit('torrent-removed', { infoHash, name: torrentName });
        broadcastTorrentUpdates();
        
        res.json({ 
            success: true, 
            message: 'Torrent removed' 
        });
    });
});

app.get('/stats', (req, res) => {
    const torrents = client.torrents.map(getTorrentStats);
    res.json({
        torrents,
        global: {
            downloadSpeed: formatSpeed(client.downloadSpeed),
            uploadSpeed: formatSpeed(client.uploadSpeed),
            totalTorrents: client.torrents.length
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        success: false, 
        message: 'Internal server error' 
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    client.destroy(() => {
        console.log('All torrents destroyed');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Torrent server running on http://localhost:${PORT}`);
    console.log(`📁 Downloads directory: ${downloadsDir}`);
    console.log(`🔌 WebSocket enabled for real-time updates`);
});