// ============================================================
// youtubeHUB Proxy Backend - Complete Server
// Railway-ready | Piped API based | Silent Download
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ MIDDLEWARE ============
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range']
}));
app.use(express.json({ limit: '10mb' }));

// In-memory job storage
const jobs = {};

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '2.0.0',
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
// ROUTE 1: CREATE JOB (Video info fetch karta hai)
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

    let downloadUrl = null;
    let videoTitle = 'Video';
    let videoDuration = 0;
    let videoThumbnail = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';
    let fileSize = 0;
    let qualityLabel = (max_resolution || '1080') + 'p';

    // Multiple Piped instances try karo (redundancy ke liye)
    const pipedInstances = [
      'https://pipedapi.kavin.rocks',
      'https://api.piped.yt',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.reallyaweso.me',
      'https://pipedapi.drgns.space'
    ];

    let pipedData = null;
    for (const instance of pipedInstances) {
      try {
        console.log('[Job] Trying:', instance);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const pipedRes = await fetch(instance + '/streams/' + videoId, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        clearTimeout(timeout);

        if (pipedRes.ok) {
          pipedData = await pipedRes.json();
          console.log('[Job] Success via:', instance);
          break;
        }
      } catch (e) {
        console.log('[Job] Failed:', instance, '-', e.message);
      }
    }

    if (!pipedData) {
      console.error('[Job] All Piped instances failed');
      return res.status(503).json({
        error: 'Unable to fetch video info',
        message: 'YouTube source unavailable. Please try again in a moment.'
      });
    }

    videoTitle = pipedData.title || 'Video';
    videoDuration = pipedData.duration || 0;
    videoThumbnail = pipedData.thumbnailUrl || videoThumbnail;

    // ============ MP3 / Audio ============
    if (format === 'mp3') {
      const audioStreams = (pipedData.audioStreams || []).filter(s => s.url);
      
      if (audioStreams.length === 0) {
        console.error('[Job] No audio streams available');
        return res.status(503).json({ error: 'No audio stream found' });
      }

      const targetBitrate = parseInt((audio_bitrate || '320k').replace('k', ''), 10) || 320;
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      let chosen = audioStreams[0];
      for (const s of audioStreams) {
        if ((s.bitrate || 0) >= targetBitrate * 1000) {
          chosen = s;
          break;
        }
        chosen = s;
      }

      downloadUrl = chosen.url;
      fileSize = chosen.contentLength || 0;
      qualityLabel = Math.round((chosen.bitrate || 128000) / 1000) + ' kbps';
    } 
    // ============ Video (MP4) ============
    else {
      const videoStreams = (pipedData.videoStreams || []).filter(s => 
        s.url && s.format === 'MPEG_4'
      );

      if (videoStreams.length === 0) {
        // Fallback: koi bhi video stream
        const fallback = (pipedData.videoStreams || []).filter(s => s.url);
        videoStreams.push(...fallback);
      }

      if (videoStreams.length === 0) {
        console.error('[Job] No video streams available');
        return res.status(503).json({ error: 'No video stream found' });
      }

      const targetRes = parseInt((max_resolution || '1080').replace('p', ''), 10) || 1080;

      // Filter by resolution (progressive streams with audio preferred)
      let filtered = videoStreams.filter(s => {
        const h = parseInt(s.quality || '0', 10);
        return h <= targetRes && h > 0 && s.videoOnly === false;
      });

      if (filtered.length === 0) {
        filtered = videoStreams.filter(s => {
          const h = parseInt(s.quality || '0', 10);
          return h <= targetRes && h > 0;
        });
      }

      if (filtered.length === 0) filtered = videoStreams;

      // Sort by height desc
      filtered.sort((a, b) => {
        const ah = parseInt(a.quality || '0', 10);
        const bh = parseInt(b.quality || '0', 10);
        return bh - ah;
      });

      const chosen = filtered[0];
      downloadUrl = chosen.url;
      fileSize = chosen.contentLength || 0;
      qualityLabel = chosen.quality ? chosen.quality + 'p' : targetRes + 'p';
    }

    if (!downloadUrl) {
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
      s3_url: downloadUrl,
      download_url: downloadUrl,
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
// ROUTE 3: ⭐ DOWNLOAD PROXY (Most Important!)
// YouTube CDN se file lekar client ko bhejta hai (CORS bypass)
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
  console.log('[Download] From:', decodedUrl.slice(0, 100) + '...');

  try {
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9'
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

    // Force browser to download (not open in tab)
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

    // node-fetch v2: body stream ko pipe karo
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

    console.log('[Download] Streaming:', safeFilename);

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
  console.log('  youtubeHUB Proxy Server v2.0.0');
  console.log('  Running on port ' + PORT);
  console.log('-------------------------------------------');
  console.log('  Endpoints:');
  console.log('  GET  /');
  console.log('  POST /proxy/jobs');
  console.log('  GET  /proxy/jobs/:id');
  console.log('  GET  /proxy/download?url=...&filename=...');
  console.log('===========================================');
});
