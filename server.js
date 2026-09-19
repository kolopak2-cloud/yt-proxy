// ============================================================
// youtubeHUB Proxy Backend v11.2 - Tornado API + Polling
// Backend waits for Tornado to complete before responding
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

const TORNADO_API_KEY = process.env.TORNADO_API_KEY || '';
const TORNADO_BASE_URL = 'https://api.tornadoapi.io';

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '11.2.0 (tornado + polling)',
    apiKeySet: !!TORNADO_API_KEY,
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

// ============ SLEEP HELPER ============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// ROUTE 1: CREATE JOB (Waits for Tornado completion)
// ============================================================
app.post('/proxy/jobs', async (req, res) => {
  try {
    const { url, format, max_resolution, audio_bitrate } = req.body;

    if (!url) return res.status(400).json({ error: 'url is required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    if (!TORNADO_API_KEY) {
      return res.status(500).json({
        error: 'Tornado API key not set',
        message: 'TORNADO_API_KEY environment variable missing'
      });
    }

    console.log('[Job] Start:', videoId, '| format:', format, '| res:', max_resolution);

    // ============ Tornado request body ============
    const tornadoBody = {
      url: url,
      filename: 'youtubehub_video'
    };

    if (format === 'mp3') {
      tornadoBody.audio_only = true;
      tornadoBody.format = 'mp3';
      const bitrate = (audio_bitrate || '320').replace('k', '').trim();
      tornadoBody.audio_bitrate = bitrate + 'k';
    } else {
      tornadoBody.format = 'mp4';
      const resNum = (max_resolution || '1080').replace('p', '').trim();
      const validRes = ['best', 'lowest', '2160', '1440', '1080', '720', '480', '360', '240', '144'];
      tornadoBody.max_resolution = validRes.includes(resNum) ? resNum : '1080';
    }

    console.log('[Job] Tornado body:', JSON.stringify(tornadoBody));

    // ============ Tornado ko call karo ============
    const createResponse = await fetch(TORNADO_BASE_URL + '/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TORNADO_API_KEY
      },
      body: JSON.stringify(tornadoBody)
    });

    const createData = await createResponse.json();
    console.log('[Job] Tornado create response:', JSON.stringify(createData).slice(0, 400));

    if (!createResponse.ok) {
      return res.status(createResponse.status).json({
        error: 'Tornado API error',
        message: createData.error || createData.message || 'HTTP ' + createResponse.status
      });
    }

    const tornadoJobId = createData.job_id;
    if (!tornadoJobId) {
      return res.status(500).json({ error: 'No job_id returned from Tornado' });
    }

    console.log('[Job] Tornado job created:', tornadoJobId);
    console.log('[Job] Polling Tornado for completion...');

    // ============================================================
    // ⭐ STEP 2: Poll Tornado until job completes (max 120 sec)
    // ============================================================
    const maxAttempts = 60;      // 60 attempts
    const pollInterval = 2000;   // 2 sec each = 120 sec total
    let finalData = null;

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(pollInterval);

      try {
        const statusResponse = await fetch(
          TORNADO_BASE_URL + '/jobs/' + tornadoJobId,
          {
            method: 'GET',
            headers: { 'x-api-key': TORNADO_API_KEY }
          }
        );

        if (!statusResponse.ok) {
          console.log('[Poll] Status fetch failed:', statusResponse.status);
          continue;
        }

        const statusData = await statusResponse.json();
        const tornadoStatus = String(statusData.status || '').toLowerCase();

        console.log('[Poll #' + (i + 1) + '] status:', tornadoStatus, '| step:', statusData.step);

        if (tornadoStatus === 'completed') {
          finalData = statusData;
          console.log('[Job] ✅ Completed!');
          break;
        }

        if (tornadoStatus === 'failed' || tornadoStatus === 'error') {
          return res.status(500).json({
            error: 'Tornado job failed',
            message: statusData.error || 'Video processing failed'
          });
        }

        // Still processing — continue loop

      } catch (e) {
        console.error('[Poll] Error:', e.message);
      }
    }

    if (!finalData) {
      return res.status(504).json({
        error: 'Timeout',
        message: 'Video processing took too long. Please try again.'
      });
    }

    // ============ Final result banao ============
    const downloadUrl = finalData.s3_url || finalData.download_url || finalData.url;

    if (!downloadUrl) {
      return res.status(500).json({
        error: 'No download URL',
        message: 'Tornado completed but no download URL'
      });
    }

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    const job = {
      id: jobId,
      state: 'completed',
      progress: 100,
      url: url,
      format: format || 'mp4',
      title: finalData.title || 'Video',
      thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
      duration: finalData.duration || 0,
      videoId: videoId,
      quality: finalData.actual_quality || (max_resolution || '1080p'),
      size: finalData.file_size || 0,
      s3_url: downloadUrl,
      download_url: downloadUrl,
      created_at: new Date().toISOString()
    };

    console.log('[Job] ✅ Sending to frontend:', jobId, '| url:', downloadUrl.slice(0, 80));

    res.json(job);

  } catch (err) {
    console.error('[Job] Fatal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 2: GET JOB STATUS (Kept for compatibility)
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

  if (!fileUrl) return res.status(400).send('Missing url parameter');

  const decodedUrl = decodeURIComponent(fileUrl);
  const safeFilename = filename
    .replace(/[^\w\s.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'video.mp4';

  console.log('[Download] Start:', safeFilename);

  try {
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };

    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const response = await fetch(decodedUrl, {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    if (!response.ok && response.status !== 206) {
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
  console.log('  youtubeHUB Proxy Server v11.2.0');
  console.log('  Tornado API + Polling');
  console.log('  API Key:', TORNADO_API_KEY ? 'SET ✅' : 'NOT SET ❌');
  console.log('  Port:', PORT);
  console.log('===========================================');
});
