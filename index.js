/**
 * Music Boy™ Local Backend Server
 * ─────────────────────────────────
 * Uses yt-dlp (system installed) for maximum reliability.
 *
 * Routes:
 *   GET /ping               → Health check
 *   GET /info?url=          → YouTube metadata (title, artist, duration, thumbnail)
 *   GET /stream?url=        → Audio stream (piped to Expo Audio)
 *   GET /lyrics?artist=&title= → Synced LRC lyrics from lrclib.net
 *
 * Usage: node index.js
 * Port: 3456
 */

const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json());

// ── Detect yt-dlp binary ───────────────────────────────────────────────────
const YT_DLP = 'yt-dlp'; // Assumes it's on PATH

// ── Helpers ────────────────────────────────────────────────────────────────

function parseYouTubeTitle(rawTitle) {
  const sep = rawTitle.match(/\s[-–]\s/);
  if (sep) {
    const idx = rawTitle.indexOf(sep[0]);
    const artist = rawTitle.slice(0, idx).trim();
    const title = rawTitle
      .slice(idx + sep[0].length)
      .replace(/\(Official[^)]*\)/gi, '')
      .replace(/\[Official[^)]*\]/gi, '')
      .replace(/\(Lyric[^)]*\)/gi, '')
      .replace(/\[Lyric[^)]*\]/gi, '')
      .replace(/\(Audio[^)]*\)/gi, '')
      .replace(/\(Video[^)]*\)/gi, '')
      .replace(/\s+ft\..*$/gi, '')
      .replace(/\s+feat\..*$/gi, '')
      .trim();
    return { artist, title };
  }
  return { artist: 'Unknown', title: rawTitle };
}

async function getYtDlpInfo(url) {
  const fs = require('fs');
  const path = require('path');
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const args = [
    '--no-playlist',
    '--dump-json',
    '--extractor-args', 'youtube:player_client=mweb'
  ];
  if (fs.existsSync(cookiesPath)) {
    args.push('--cookies', cookiesPath);
  }
  args.push(url);

  const { stdout } = await execFileAsync(YT_DLP, args, { timeout: 30000 });
  return JSON.parse(stdout);
}

function parseLyricsResponse(data) {
  const plain = data.plainLyrics ?? null;
  const lrc = data.syncedLyrics ?? null;

  if (!lrc) return { synced: [], plain, hasSync: false };

  const lines = lrc.split('\n');
  const synced = [];
  const lrcRegex = /^\[(\d{2}):(\d{2}\.\d+)\]\s*(.*)/;

  for (const line of lines) {
    const match = line.match(lrcRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const timeMs = (minutes * 60 + seconds) * 1000;
      const text = match[3].trim();
      if (text) synced.push({ time: timeMs, text });
    }
  }

  return { synced, plain, hasSync: synced.length > 0 };
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/ping', (_, res) => res.json({ ok: true, version: '1.0.0' }));

/**
 * GET /info?url=<youtube_url>
 */
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const info = await getYtDlpInfo(url);
    const { artist, title } = parseYouTubeTitle(info.title);

    const thumbnail = info.thumbnails
      ? info.thumbnails[info.thumbnails.length - 1]?.url
      : info.thumbnail;

    // Find the best audio-only format with a direct URL
    const formats = info.formats || [];
    const audioFormats = formats.filter(f =>
      f.vcodec === 'none' &&
      f.url &&
      !f.url.includes('manifest') &&
      !f.url.includes('m3u8') &&
      (f.audio_ext === 'webm' || f.audio_ext === 'm4a' || f.ext === 'webm' || f.ext === 'm4a')
    );

    // Sort by bitrate descending, pick best
    audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const bestAudio = audioFormats[0];

    if (!bestAudio) {
      return res.status(500).json({ error: 'No direct audio format found. YouTube may be blocking this video.' });
    }

    res.json({
      id: info.id,
      rawTitle: info.title,
      title,
      artist,
      duration: info.duration ?? 0,
      thumbnail: thumbnail ?? null,
      streamUrl: bestAudio.url, // Direct URL — no proxy needed!
    });
  } catch (err) {
    console.error('[/info] Error:', err.message);
    res.status(500).json({ error: 'Could not fetch video info: ' + err.message });
  }
});

/**
 * GET /stream?url=<youtube_url>
 * Pipes audio-only stream from yt-dlp to the client.
 */
app.get('/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    // Get format first to determine mime type
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Transfer-Encoding', 'chunked');

    const ytdlp = spawn(YT_DLP, [
      '--no-playlist',
      '-f', 'bestaudio',
      '--extractor-args', 'youtube:player_client=tv_embedded',
      '-o', '-',
      '--no-part',
      url,
    ]);

    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', (data) => {
      // Log progress to server console (not sent to client)
      process.stdout.write('[yt-dlp] ' + data.toString());
    });

    ytdlp.on('error', (err) => {
      console.error('[stream] spawn error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) console.log(`[stream] yt-dlp exited with code ${code}`);
    });

    req.on('close', () => {
      ytdlp.kill();
    });
  } catch (err) {
    console.error('[/stream] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/**
 * GET /lyrics?artist=<artist>&title=<title>
 */
app.get('/lyrics', async (req, res) => {
  const { artist, title } = req.query;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist && artist !== 'Unknown') params.set('artist_name', artist);

    // Always use search — it returns multiple results so we can pick the best
    const searchRes = await fetch(
      `https://lrclib.net/api/search?${params.toString()}`,
      { headers: { 'Lrclib-Client': 'MusicBoy/1.0 (local)' } }
    );

    if (!searchRes.ok) return res.json({ synced: [], plain: null, hasSync: false });

    const results = await searchRes.json();
    if (!results || results.length === 0) {
      return res.json({ synced: [], plain: null, hasSync: false });
    }

    // Filter out "probe" placeholder results, prefer those with syncedLyrics
    const valid = results.filter(r =>
      r.plainLyrics && r.plainLyrics !== 'probe' &&
      r.syncedLyrics && r.syncedLyrics !== '[00:00.00]probe'
    );

    const withSync = valid.filter(r => r.syncedLyrics);
    const best = withSync.length > 0 ? withSync[0] : (valid[0] ?? results[0]);

    return res.json(parseLyricsResponse(best));
  } catch (err) {
    console.error('[/lyrics] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 Music Boy™ Backend running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<YOUR_PC_IP>:${PORT}`);
  console.log(`\n   Endpoints:`);
  console.log(`   /ping              — health check`);
  console.log(`   /info?url=         — YouTube info`);
  console.log(`   /stream?url=       — audio stream`);
  console.log(`   /lyrics?artist=&title= — karaoke lyrics\n`);
});
