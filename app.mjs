import express from 'express';
import WebTorrent from 'webtorrent';
import fs from 'fs-extra';
import path from 'path'; 
import { fileURLToPath } from 'url'; 
import { dirname } from 'path';

const app = express();
const client = new WebTorrent();
const pausedTorrents = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.set('view engine', 'ejs');
app.use(express.static('public'));

app.get('/', (req, res) => {
    const torrents = client.torrents.map(torrent => ({
        infoHash: torrent.infoHash,
        name: torrent.name,
        size: (torrent.length / (1024 * 1024)).toFixed(2) + ' MB',
        downloaded: (torrent.downloaded / (1024 * 1024)).toFixed(2) + ' MB',
        downloadSpeed: (torrent.downloadSpeed / (1024)).toFixed(2) + ' kB/s'
    }));
    res.render('index', { torrents, pausedTorrents: Array.from(pausedTorrents.keys()) }); 
});

app.get('/add', (req, res) => {
    const magnetURI = req.query.magnet;
    if (magnetURI) {
        client.add(magnetURI, torrent => {
            console.log(`Torrent added: ${torrent.name}`);

            torrent.on('done', async () => {
                const torrentFiles = torrent.files;
                const safeTorrentName = torrent.name.replace(/[\/\\?%*:|"<>]/g, '_'); 
                const downloadPath = path.join(__dirname, 'downloads', safeTorrentName);

                try {
                    await fs.ensureDir(downloadPath);

                    await Promise.all(torrentFiles.map(async file => {
                        const safeFilePath = file.path.replace(/[\/\\?%*:|"<>]/g, '_');
                        const filePath = path.join(downloadPath, safeFilePath);
                        await new Promise((resolve, reject) => {
                            file.createReadStream().pipe(fs.createWriteStream(filePath))
                                .on('error', reject)
                                .on('finish', resolve);
                        });
                    }));
                    console.log(`Files for ${torrent.name} saved successfully.`);
                } catch (err) {
                    console.error('Error saving files:', err);
                }
            });
        });
    }
    res.redirect('/');
});

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
