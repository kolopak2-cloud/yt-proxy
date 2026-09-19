// ============================================================
// youtubeHUB Proxy Backend v9.0 - cobalt.tools based
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

// ============ COBALT INSTANCES ============
const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://co.wuk.sh',
  'https://cobalt-api.kwiatekmiki.com',
  'https://api.cobalt.best',
  'https://cobalt.255x.ru'
];

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '9.0.0 (cobalt)',
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
// ROUTE 1: CREATE JOB (cobalt API)
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

    // ============ Cobalt request body ============
    const cobaltBody = {
      url: url,
      videoQuality: format === 'mp3' ? '360' : String((max_resolution || '720').replace('p', '')),
      audioFormat: 'mp3',
      downloadMode: format === 'mp3' ? 'audio' : 'auto',
      filenamePattern: 'basic'
    };

    // ============ Try each cobalt instance ============
    let cobaltResult = null;
    let workingInstance = null;

    for (const instance of COBALT_INSTANCES) {
      try {
        console.log('[Job] Trying:', instance);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const apiRes = await fetch(instance + '/', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          body: JSON.stringify(cobaltBody)
        });
        clearTimeout(timeout);

        console.log('[Job] Status:', apiRes.status);

        if (apiRes.ok) {
          const data = await apiRes.json();
          console.log('[Job] Response:', JSON.stringify(data).slice(0, 300));

          if (data.status === 'tunnel' || data.status === 'redirect' || data.url) {
            cobaltResult = data;
            workingInstance = instance;
            break;
          } else if (data.status === 'error') {
            console.log('[Job] Cobalt error:', data.error && data.error.code);
          }
        }
      } catch (e) {
        console.log('[Job] Failed:', instance, '-', e.message);
      }
    }

    if (!cobaltResult) {
      return res.status(503).json({
        error: 'All cobalt instances failed',
        message: 'Please try again in a moment.'
      });
    }

    // Cobalt tunnel URL alag hoti hai — usay apne download proxy se serve karenge
    const downloadUrl = cobaltResult.url;

    // Basic title fetch (YouTube thumbnail se)
    const videoTitle = 'Video';
    const videoThumbnail = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    const job = {
      id: jobId,
      state: 'completed',
      progress: 100,
      url: url,
      format: format || 'mp4',
      title: videoTitle,
      thumbnail: videoThumbnail,
      duration: 0,
      videoId: videoId,
      quality: (max_resolution || '720') + 'p',
      size: 0,
      s3_url: downloadUrl,
      download_url: downloadUrl,
      filename: cobaltResult.filename || ('video.' + (format === 'mp3' ? 'mp3' : 'mp4')),
      source: workingInstance,
      created_at: new Date().toISOString()
    };

    console.log('[Job] Ready ✅:', jobId, '|', downloadUrl.slice(0, 80));

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
  console.log('[Download] URL:', decodedUrl.slice(0, 100));

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
  console.log('  youtubeHUB Proxy Server v9.0.0');
  console.log('  Using cobalt.tools API');
  console.log('  Port:', PORT);
  console.log('===========================================');
});
