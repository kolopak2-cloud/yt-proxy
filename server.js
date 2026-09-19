// ============================================================
// youtubeHUB Proxy Backend v4.0 - Invidious API based
// No cookies needed | Simple & Reliable
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

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
    version: '4.0.0 (invidious)',
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

// ============ INVIDIOUS INSTANCES (Multiple fallback) ============
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.f5.si',
  'https://iv.melmac.space',
  'https://invidious.privacyredirect.com',
  'https://invidious.reallyaweso.me',
  'https://inv.tux.pizza'
];

// ============================================================
// ROUTE 1: CREATE JOB (Invidious se video info)
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

    // ============ Multiple Invidious instances try karo ============
    let videoData = null;
    let workingInstance = null;

    for (const instance of INVIDIOUS_INSTANCES) {
      try {
        console.log('[Job] Trying:', instance);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const apiRes = await fetch(instance + '/api/v1/videos/' + videoId, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          }
        });
        clearTimeout(timeout);

        if (apiRes.ok) {
          videoData = await apiRes.json();
          workingInstance = instance;
          console.log('[Job] Success via:', instance);
          break;
        } else {
          console.log('[Job] Bad status:', apiRes.status, 'from', instance);
        }
      } catch (e) {
        console.log('[Job] Failed:', instance, '-', e.message);
      }
    }

    if (!videoData) {
      return res.status(503).json({
        error: 'All Invidious instances failed',
        message: 'YouTube source unavailable. Please try again.'
      });
    }

    const videoTitle = videoData.title || 'Video';
    const videoDuration = videoData.lengthSeconds || 0;
    const videoThumbnail = videoData.videoThumbnails && videoData.videoThumbnails[0]
                         ? videoData.videoThumbnails[0].url
                         : 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    let chosenUrl = null;
    let qualityLabel = '1080p';
    let fileSize = 0;

    // ============ Format Selection ============
    if (format === 'mp3') {
      // ===== AUDIO =====
      const audioFormats = (videoData.adaptiveFormats || []).filter(f =>
        f.type && f.type.indexOf('audio') === 0
      );

      if (audioFormats.length === 0) {
        return res.status(503).json({ error: 'No audio formats available' });
      }

      const targetBitrate = parseInt((audio_bitrate || '320k').replace('k', ''), 10) || 320;

      // Sort by bitrate descending
      audioFormats.sort((a, b) => {
        const ab = parseInt((a.bitrate || '0').toString().replace(/[^\d]/g, ''), 10) || 0;
        const bb = parseInt((b.bitrate || '0').toString().replace(/[^\d]/g, ''), 10) || 0;
        return bb - ab;
      });

      let chosen = audioFormats[0];
      for (const f of audioFormats) {
        const fBitrate = parseInt((f.bitrate || '0').toString().replace(/[^\d]/g, ''), 10) || 0;
        if (fBitrate <= targetBitrate * 1000) {
          chosen = f;
          break;
        }
        chosen = f;
      }

      chosenUrl = chosen.url;
      fileSize = parseInt(chosen.clen || 0, 10) || 0;
      const bitrateNum = parseInt((chosen.bitrate || '128000').toString().replace(/[^\d]/g, ''), 10) || 128000;
      qualityLabel = Math.round(bitrateNum / 1000) + ' kbps';
    } else {
      // ===== VIDEO =====
      const targetRes = parseInt((max_resolution || '1080').replace('p', ''), 10) || 1080;

      // Progressive streams (video + audio combined) - formatStreams array mein hote hain
      let progressive = (videoData.formatStreams || []).filter(f => {
        const h = parseInt((f.resolution || '0').replace('p', ''), 10) || 0;
        return h <= targetRes && h > 0;
      });

      if (progressive.length > 0) {
        // Sort by resolution descending
        progressive.sort((a, b) => {
          const ah = parseInt((a.resolution || '0').replace('p', ''), 10) || 0;
          const bh = parseInt((b.resolution || '0').replace('p', ''), 10) || 0;
          return bh - ah;
        });
        chosenUrl = progressive[0].url;
        qualityLabel = progressive[0].resolution || targetRes + 'p';
        fileSize = parseInt(progressive[0].clen || 0, 10) || 0;
      } else {
        // Agar progressive na mile, to adaptive video try karo
        let adaptive = (videoData.adaptiveFormats || []).filter(f =>
          f.type && f.type.indexOf('video') === 0
        );

        adaptive = adaptive.filter(f => {
          const h = parseInt((f.resolution || '0').replace('p', ''), 10) || 0;
          return h <= targetRes && h > 0;
        });

        if (adaptive.length > 0) {
          adaptive.sort((a, b) => {
            const ah = parseInt((a.resolution || '0').replace('p', ''), 10) || 0;
            const bh = parseInt((b.resolution || '0').replace('p', ''), 10) || 0;
            return bh - ah;
          });
          chosenUrl = adaptive[0].url;
          qualityLabel = adaptive[0].resolution || targetRes + 'p';
          fileSize = parseInt(adaptive[0].clen || 0, 10) || 0;
        }
      }

      if (!chosenUrl) {
        return res.status(503).json({ error: 'No video formats available' });
      }
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
      source: workingInstance,
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
  console.log('  youtubeHUB Proxy Server v4.0.0');
  console.log('  Using Invidious API (no cookies!)');
  console.log('  Running on port ' + PORT);
  console.log('===========================================');
});
