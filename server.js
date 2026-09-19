// ============================================================
// youtubeHUB Proxy Backend v8.0 - yt-dlp + Dockerfile
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range']
}));
app.use(express.json({ limit: '10mb' }));

// ============ COOKIES SETUP ============
const COOKIES_PATH = '/tmp/cookies.txt';
let cookiesReady = false;

try {
  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES, 'utf8');
    cookiesReady = true;
    console.log('[Cookies] Loaded ✅ (' + process.env.YOUTUBE_COOKIES.length + ' bytes)');
  } else {
    console.log('[Cookies] WARNING: YOUTUBE_COOKIES not set');
  }
} catch (e) {
  console.error('[Cookies] Failed:', e.message);
}

// ============ YT-DLP CHECK ============
let ytDlpVersion = 'unknown';
(async () => {
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['--version']);
    ytDlpVersion = stdout.trim();
    console.log('[yt-dlp] Version:', ytDlpVersion);
  } catch (e) {
    console.error('[yt-dlp] Not available:', e.message);
  }
})();

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '8.0.0 (yt-dlp + docker)',
    ytDlp: ytDlpVersion,
    cookies: cookiesReady ? 'loaded' : 'missing',
    time: new Date().toISOString()
  });
});

// ============ VIDEO ID EXTRACTOR ============
function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

// ============================================================
// ROUTE 1: CREATE JOB (yt-dlp)
// ============================================================
app.post('/proxy/jobs', async (req, res) => {
  try {
    const { url, format, max_resolution, audio_bitrate } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log('[Job] Start:', videoId, '| format:', format);

    // ============ yt-dlp command banao ============
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-check-certificates',
      '--prefer-free-formats',
      '--no-playlist'
    ];

    if (cookiesReady && fs.existsSync(COOKIES_PATH)) {
      args.push('--cookies', COOKIES_PATH);
      console.log('[Job] Using cookies');
    }

    args.push(url);

    // ============ yt-dlp run karo ============
    let info;
    try {
      const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60000
      });

      if (stderr && stderr.trim()) {
        console.log('[yt-dlp stderr]:', stderr.slice(0, 500));
      }

      info = JSON.parse(stdout);
    } catch (err) {
      console.error('[Job] yt-dlp failed:', err.message);
      console.error('[Job] stderr:', (err.stderr || '').slice(0, 1000));
      return res.status(503).json({
        error: 'YouTube fetch failed',
        message: err.message.slice(0, 200)
      });
    }

    const videoTitle = info.title || 'Video';
    const videoDuration = info.duration || 0;
    const videoThumbnail = info.thumbnail || 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    let chosenUrl = null;
    let qualityLabel = '720p';
    let fileSize = 0;

    const formats = info.formats || [];

    // ============ Format Selection ============
    if (format === 'mp3') {
      const audioFormats = formats.filter(f =>
        f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && f.url
      );

      if (audioFormats.length === 0) {
        return res.status(503).json({ error: 'No audio format' });
      }

      const targetBitrate = parseInt((audio_bitrate || '320k').replace('k', ''), 10) || 320;
      audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));

      let chosen = audioFormats[0];
      for (const f of audioFormats) {
        if ((f.abr || 0) <= targetBitrate) {
          chosen = f;
          break;
        }
        chosen = f;
      }

      chosenUrl = chosen.url;
      qualityLabel = Math.round(chosen.abr || 128) + ' kbps';
      fileSize = chosen.filesize || chosen.filesize_approx || 0;
    } else {
      const targetRes = parseInt((max_resolution || '720').replace('p', ''), 10) || 720;

      // Progressive (video + audio combined)
      let progressive = formats.filter(f =>
        f.ext === 'mp4' &&
        f.vcodec && f.vcodec !== 'none' &&
        f.acodec && f.acodec !== 'none' &&
        f.url &&
        (f.height || 0) <= targetRes
      );

      if (progressive.length > 0) {
        progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
        const chosen = progressive[0];
        chosenUrl = chosen.url;
        qualityLabel = chosen.height ? chosen.height + 'p' : targetRes + 'p';
        fileSize = chosen.filesize || chosen.filesize_approx || 0;
      } else {
        // Video-only fallback
        let videoOnly = formats.filter(f =>
          f.vcodec && f.vcodec !== 'none' &&
          f.url &&
          (f.height || 0) <= targetRes
        );
        videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0));

        if (videoOnly.length > 0) {
          const chosen = videoOnly[0];
          chosenUrl = chosen.url;
          qualityLabel = chosen.height ? chosen.height + 'p' : targetRes + 'p';
          fileSize = chosen.filesize || chosen.filesize_approx || 0;
        } else {
          // Any video
          const anyVideo = formats.filter(f => f.url && f.vcodec && f.vcodec !== 'none');
          if (anyVideo.length > 0) {
            chosenUrl = anyVideo[anyVideo.length - 1].url;
            qualityLabel = anyVideo[anyVideo.length - 1].height
              ? anyVideo[anyVideo.length - 1].height + 'p'
              : '720p';
          }
        }
      }
    }

    if (!chosenUrl) {
      return res.status(503).json({ error: 'No download URL available' });
    }

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    const job = {
      id: jobId,
      state: 'completed',
      progress: 100,
      url: url,
      format: format || 'mp4',
      title: videoTitle,
      thumbnail: videoThumbnail,
      duration: videoDuration,
      videoId: videoId,
      quality: qualityLabel,
      size: fileSize,
      s3_url: chosenUrl,
      download_url: chosenUrl,
      created_at: new Date().toISOString()
    };

    console.log('[Job] Ready ✅:', jobId, '|', qualityLabel, '|', videoTitle.slice(0, 50));

    res.json(job);

  } catch (err) {
    console.error('[Job] Fatal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 2: GET JOB STATUS
// ============================================================
app.get('/proxy/jobs/:id', (req, res) => {
  res.json({ id: req.params.id, state: 'completed' });
});

// ============================================================
// ROUTE 3: DOWNLOAD PROXY
// ============================================================
app.get('/proxy/download', async (req, res) => {
  const fileUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!fileUrl) {
    return res.status(400).send('Missing url parameter');
  }

  const decodedUrl = decodeURIComponent(fileUrl);
  const safeFilename = filename
    .replace(/[^\w\s.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'video.mp4';

  console.log('[Download] Start:', safeFilename);

  try {
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com'
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(decodedUrl, {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    if (!response.ok && response.status !== 206) {
      console.error('[Download] Upstream error:', response.status);
      return res.status(response.status).send('Upstream error: ' + response.status);
    }

    res.setHeader('Content-Disposition', 'attachment; filename="' + safeFilename + '"');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range');
    res.setHeader('Cache-Control', 'no-cache');

    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
      res.status(206);
    }

    if (response.body && typeof response.body.pipe === 'function') {
      response.body.pipe(res);
      response.body.on('error', (err) => {
        console.error('[Download] Stream error:', err.message);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
    } else {
      const buffer = await response.buffer();
      res.send(buffer);
    }

  } catch (err) {
    console.error('[Download] Fatal:', err);
    if (!res.headersSent) {
      res.status(500).send('Download failed: ' + err.message);
    } else {
      res.end();
    }
  }
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log('===========================================');
  console.log('  youtubeHUB Proxy Server v8.0.0');
  console.log('  yt-dlp version:', ytDlpVersion);
  console.log('  Cookies:', cookiesReady ? 'LOADED ✅' : 'MISSING ❌');
  console.log('  Port:', PORT);
  console.log('===========================================');
});
