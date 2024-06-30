import express from 'express';
import WebTorrent from 'webtorrent';
import fs from 'fs-extra'; // Import fs-extra for file operations
import path from 'path'; // Import path for handling file paths

const app = express();
const client = new WebTorrent();
const pausedTorrents = new Map(); // Initialize pausedTorrents Map

app.set('view engine', 'ejs');
app.use(express.static('public'));

// Route to display the torrent details
app.get('/', (req, res) => {
    const torrents = client.torrents.map(torrent => ({
        infoHash: torrent.infoHash,
        name: torrent.name,
        size: (torrent.length / (1024 * 1024)).toFixed(2) + ' MB',
        downloaded: (torrent.downloaded / (1024 * 1024)).toFixed(2) + ' MB',
        downloadSpeed: (torrent.downloadSpeed / (1024)).toFixed(2) + ' kB/s'
    }));
    res.render('index', { torrents, pausedTorrents: Array.from(pausedTorrents.keys()) }); // Pass pausedTorrents as an array of keys
});

// Route to add a torrent
app.get('/add', (req, res) => {
    const magnetURI = req.query.magnet;
    if (magnetURI) {
        client.add(magnetURI, torrent => {
            console.log(`Torrent added: ${torrent.name}`);

            // When torrent finishes downloading
            torrent.on('done', async () => {
                const torrentFiles = torrent.files;
                const downloadPath = path.join(__dirname, 'downloads', torrent.name);

                try {
                    // Ensure downloads directory exists
                    await fs.ensureDir(downloadPath);

                    // Iterate through files and save them to the downloads directory
                    await Promise.all(torrentFiles.map(async file => {
                        const filePath = path.join(downloadPath, file.path);
                        await new Promise((resolve, reject) => {
                            file.createReadStream().pipe(fs.createWriteStream(filePath))
                                .on('error', reject)
                                .on('finish', resolve);
                        });
                    }));
                } catch (err) {
                    console.error('Error saving files:', err);
                }
            });
        });
    }
    res.redirect('/');
});


// Route to pause a torrent
app.get('/pause/:infoHash', (req, res) => {
    const torrent = client.get(req.params.infoHash);
    if (torrent) {
        pausedTorrents.set(req.params.infoHash, torrent.magnetURI);
        torrent.destroy(() => {
            console.log(`Torrent paused: ${torrent.name}`);
        });
    }
    res.redirect('/');
});

// Route to resume a paused torrent
app.get('/resume/:infoHash', (req, res) => {
    const magnetURI = pausedTorrents.get(req.params.infoHash);
    if (magnetURI) {
        client.add(magnetURI, torrent => {
            console.log(`Torrent resumed: ${torrent.name}`);
        });
        pausedTorrents.delete(req.params.infoHash);
    }
    res.redirect('/');
});

// Route to delete a torrent
app.get('/delete/:infoHash', (req, res) => {
    const torrent = client.get(req.params.infoHash);
    if (torrent) {
        torrent.destroy(() => {
            console.log(`Torrent removed: ${torrent.name}`);
        });
    }
    res.redirect('/');
});

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
