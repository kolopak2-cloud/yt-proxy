// ============================================================
// youtubeHUB Proxy Backend v6.0 - yt-dlp + Cookies
// 100% reliable YouTube download
// ============================================================

const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range']
}));
app.use(express.json({ limit: '10mb' }));

const jobs = {};

// ============================================================
// COOKIES SETUP - Environment variable se read karo
// ============================================================
const COOKIES_PATH = '/tmp/cookies.txt';
let cookiesReady = false;

try {
  if (process.env.YOUTUBE_COOKIES) {
    // Railway variable se cookies file banao
    fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES, 'utf8');
    cookiesReady = true;
    console.log('[Cookies] Loaded from environment variable');
  } else {
    console.log('[Cookies] WARNING: YOUTUBE_COOKIES not set. Some videos may fail.');
  }
} catch (e) {
  console.error('[Cookies] Failed to write:', e.message);
}

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '6.0.0 (yt-dlp + cookies)',
    cookies: cookiesReady ? 'loaded' : 'missing',
    time: new Date().toISOString()
  });
});

// ============ VIDEO ID EXTRACTOR ============
function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

// ============================================================
// ROUTE 1: CREATE JOB
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

    console.log('[Job] Creating for:', videoId, '| format:', format);

    // yt-dlp options
    const ytdlOptions = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    };

    // Cookies add karo agar available hain
    if (cookiesReady && fs.existsSync(COOKIES_PATH)) {
      ytdlOptions.cookies = COOKIES_PATH;
      console.log('[Job] Using cookies');
    }

    let info;
    try {
      info = await youtubedl(url, ytdlOptions);
    } catch (err) {
      console.error('[Job] yt-dlp error:', err.message);
      return res.status(503).json({
        error: 'YouTube blocked the request',
        message: cookiesReady
          ? 'Cookies expire ho gayi hain. Naye cookies export karein.'
          : 'Cookies set nahi hain. YOUTUBE_COOKIES variable add karein.'
      });
    }

    const durationSec = parseInt(info.duration, 10) || 0;
    const videoTitle = info.title || 'Video';
    const videoThumbnail = info.thumbnail || 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    let chosenFormatUrl = null;
    let qualityLabel = '1080p';
    let fileSize = 0;

    try {
      if (format === 'mp3') {
        const audioFormats = (info.formats || []).filter(f =>
          f.vcodec === 'none' && f.acodec !== 'none' && f.url
        );
        if (audioFormats.length === 0) throw new Error('No audio format');

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

        chosenFormatUrl = chosen.url;
        qualityLabel = Math.round(chosen.abr || 128) + ' kbps';
        fileSize = chosen.filesize || chosen.filesize_approx || 0;
      } else {
        const targetRes = parseInt((max_resolution || '1080').replace('p', ''), 10) || 1080;

        let progressive = (info.formats || []).filter(f =>
          f.ext === 'mp4' &&
          f.vcodec !== 'none' &&
          f.acodec !== 'none' &&
          f.url &&
          (f.height || 0) <= targetRes
        );

        if (progressive.length > 0) {
          progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
          chosenFormatUrl = progressive[0].url;
          qualityLabel = progressive[0].height ? progressive[0].height + 'p' : targetRes + 'p';
          fileSize = progressive[0].filesize || progressive[0].filesize_approx || 0;
        } else {
          // Fallback: video-only (highest quality)
          let videoOnly = (info.formats || []).filter(f =>
            f.vcodec !== 'none' && f.url && (f.height || 0) <= targetRes
          );
          videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0));

          if (videoOnly.length > 0) {
            chosenFormatUrl = videoOnly[0].url;
            qualityLabel = videoOnly[0].height ? videoOnly[0].height + 'p' : targetRes + 'p';
            fileSize = videoOnly[0].filesize || videoOnly[0].filesize_approx || 0;
          }
        }

        if (!chosenFormatUrl) {
          // Final fallback: any mp4
          const anyMp4 = (info.formats || []).filter(f => f.ext === 'mp4' && f.url);
          if (anyMp4.length > 0) {
            chosenFormatUrl = anyMp4[anyMp4.length - 1].url;
            qualityLabel = anyMp4[anyMp4.length - 1].height
              ? anyMp4[anyMp4.length - 1].height + 'p'
              : '720p';
          }
        }

        if (!chosenFormatUrl) {
          throw new Error('No suitable video format');
        }
      }
    } catch (err) {
      console.error('[Job] Format selection error:', err.message);
      return res.status(500).json({
        error: 'No suitable format found',
        message: err.message
      });
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
      duration: durationSec,
      videoId: videoId,
      quality: qualityLabel,
      size: fileSize,
      s3_url: chosenFormatUrl,
      download_url: chosenFormatUrl,
      created_at: new Date().toISOString()
    };

    jobs[jobId] = job;
    console.log('[Job] Ready:', jobId, '|', qualityLabel, '|', videoTitle.slice(0, 50));

    res.json(job);

  } catch (err) {
    console.error('[Job] Fatal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 2: GET JOB STATUS
// ============================================================
app.get('/proxy/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
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
    const fetch = require('node-fetch');

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

    console.log('[Download] Done:', safeFilename);

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
  console.log('  youtubeHUB Proxy Server v6.0.0');
  console.log('  yt-dlp + cookies');
  console.log('  Cookies:', cookiesReady ? 'LOADED' : 'MISSING');
  console.log('  Port:', PORT);
  console.log('===========================================');
});
