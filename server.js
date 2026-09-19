// ============================================================
// youtubeHUB Proxy Backend v3.0 - ytdl-core based
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range']
}));
app.use(express.json({ limit: '10mb' }));

const jobs = {};

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '3.0.0',
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
// ROUTE 1: CREATE JOB (ytdl-core se video info)
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

    console.log('[Job] Creating for:', videoId, '| format:', format, '| max_res:', max_resolution);

    // ============ ytdl-core se info fetch karo ============
    let info;
    try {
      info = await ytdl.getInfo(videoId, {
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        }
      });
    } catch (err) {
      console.error('[Job] ytdl getInfo failed:', err.message);
      return res.status(503).json({
        error: 'Unable to fetch video info',
        message: 'YouTube blocked the request. Try again in a moment.'
      });
    }

    const durationSec = parseInt(info.videoDetails.lengthSeconds, 10) || 0;
    const videoTitle = info.videoDetails.title || 'Video';
    const videoThumbnail = (info.videoDetails.thumbnails.slice(-1)[0] || {}).url
                        || 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    let chosenFormat;
    let qualityLabel = '1080p';

    // ============ Format Selection ============
    try {
      if (format === 'mp3') {
        chosenFormat = ytdl.chooseFormat(info.formats, {
          quality: 'highestaudio',
          filter: 'audioonly'
        });
        if (!chosenFormat) throw new Error('No audio format');
        qualityLabel = Math.round((chosenFormat.audioBitrate || 128)) + ' kbps';
      } else {
        const targetRes = parseInt((max_resolution || '1080').replace('p', ''), 10) || 1080;

        // Filter progressive (audio+video) MP4 formats
        const mp4Progressive = info.formats.filter(f =>
          f.container === 'mp4' &&
          f.hasVideo &&
          f.hasAudio &&
          (f.height || 0) <= targetRes
        );

        if (mp4Progressive.length > 0) {
          // Sort by height desc
          mp4Progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
          chosenFormat = mp4Progressive[0];
        } else {
          // Fallback: any mp4 with video
          const mp4Any = info.formats.filter(f => f.container === 'mp4' && f.hasVideo);
          mp4Any.sort((a, b) => (b.height || 0) - (a.height || 0));
          chosenFormat = mp4Any[0];
        }

        if (!chosenFormat) {
          chosenFormat = ytdl.chooseFormat(info.formats, { quality: 'highest' });
        }

        if (!chosenFormat) throw new Error('No suitable video format');
        qualityLabel = chosenFormat.qualityLabel || (chosenFormat.height ? chosenFormat.height + 'p' : '720p');
      }
    } catch (err) {
      console.error('[Job] Format selection error:', err.message);
      return res.status(500).json({
        error: 'No suitable format found',
        message: err.message
      });
    }

    if (!chosenFormat || !chosenFormat.url) {
      return res.status(500).json({ error: 'No download URL available' });
    }

    const fileSize = parseInt(chosenFormat.contentLength || 0, 10) || 0;
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
      s3_url: chosenFormat.url,
      download_url: chosenFormat.url,
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
  console.log('  youtubeHUB Proxy Server v3.0.0');
  console.log('  Running on port ' + PORT);
  console.log('  Using @distube/ytdl-core');
  console.log('===========================================');
});
