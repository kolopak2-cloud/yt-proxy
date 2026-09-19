// ============================================================
// youtubeHUB Proxy Backend v11.1 - Tornado API (fixed)
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

const jobMap = {};

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '11.1.0 (tornado)',
    apiKeySet: !!TORNADO_API_KEY,
    time: new Date().toISOString()
  });
});

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

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

    console.log('[Job] Creating for:', videoId, '| format:', format);

    const tornadoBody = {
      url: url,
      filename: 'youtubehub_video'
    };

    if (format === 'mp3') {
      tornadoBody.audio_only = true;
      tornadoBody.format = 'mp3';
      tornadoBody.audio_bitrate = (audio_bitrate || '320').replace('k', '') + 'k';
    } else {
      tornadoBody.format = 'mp4';
      // ⭐ YEH LINE FIX KI HAI — bina "p" ke
      const resNum = (max_resolution || '1080').replace('p', '').trim();
      // Valid options check karo
      const validRes = ['best', 'lowest', '2160', '1440', '1080', '720', '480', '360', '240', '144'];
      tornadoBody.max_resolution = validRes.includes(resNum) ? resNum : '1080';
    }

    console.log('[Job] Tornado body:', JSON.stringify(tornadoBody));

    const response = await fetch(TORNADO_BASE_URL + '/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TORNADO_API_KEY
      },
      body: JSON.stringify(tornadoBody)
    });

    const data = await response.json();
    console.log('[Job] Tornado response:', JSON.stringify(data).slice(0, 300));

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Tornado API error',
        message: data.error || data.message || 'HTTP ' + response.status
      });
    }

    const tornadoJobId = data.job_id;
    if (!tornadoJobId) {
      return res.status(500).json({ error: 'No job_id returned from Tornado' });
    }

    const internalId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    jobMap[internalId] = {
      tornadoJobId: tornadoJobId,
      videoId: videoId,
      format: format || 'mp4',
      quality: max_resolution || '1080p',
      createdAt: Date.now()
    };

    console.log('[Job] Created:', internalId, '->', tornadoJobId);

    res.json({
      id: internalId,
      job_id: internalId,
      videoId: videoId,
      state: 'pending',
      status: 'pending',
      progress: 0,
      title: 'Processing...',
      format: format || 'mp4',
      quality: max_resolution || '1080p'
    });

  } catch (err) {
    console.error('[Job] Fatal:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/proxy/jobs/:id', async (req, res) => {
  try {
    const internalId = req.params.id;
    const jobInfo = jobMap[internalId];

    if (!jobInfo) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const response = await fetch(TORNADO_BASE_URL + '/jobs/' + jobInfo.tornadoJobId, {
      method: 'GET',
      headers: {
        'x-api-key': TORNADO_API_KEY
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Tornado status fetch failed',
        state: 'failed',
        status: 'failed'
      });
    }

    const data = await response.json();
    console.log('[Status]', internalId, '->', data.status, '| step:', data.step);

    let frontendState = 'processing';
    let progress = 50;

    const tornadoStatus = String(data.status || '').toLowerCase();

    if (tornadoStatus === 'completed') {
      frontendState = 'completed';
      progress = 100;
    } else if (tornadoStatus === 'failed' || tornadoStatus === 'error') {
      frontendState = 'failed';
      progress = 0;
    } else if (tornadoStatus === 'pending') {
      frontendState = 'pending';
      progress = 10;
    } else if (tornadoStatus === 'processing') {
      frontendState = 'processing';
      progress = data.step === 'Downloading' ? 40 :
                  data.step === 'Muxing' ? 70 :
                  data.step === 'Uploading' ? 90 : 30;
    }

    const result = {
      id: internalId,
      job_id: internalId,
      state: frontendState,
      status: frontendState,
      progress: progress,
      videoId: jobInfo.videoId,
      title: data.title || 'Video',
      quality: data.actual_quality || jobInfo.quality,
      format: jobInfo.format,
      size: data.file_size || 0,
      duration: 0
    };

    if (frontendState === 'completed' && data.s3_url) {
      result.s3_url = data.s3_url;
      result.download_url = data.s3_url;
    }

    if (frontendState === 'failed') {
      result.message = data.error || 'Download failed';
      result.error = data.error || 'Download failed';
    }

    res.json(result);

  } catch (err) {
    console.error('[Status] Fatal:', err);
    res.status(500).json({
      error: err.message,
      state: 'failed',
      status: 'failed'
    });
  }
});

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
    if (!res.headersSent) res.status(500).send('Download failed: ' + err.message);
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log('===========================================');
  console.log('  youtubeHUB Proxy Server v11.1.0');
  console.log('  Using Tornado API (fixed resolution)');
  console.log('  API Key:', TORNADO_API_KEY ? 'SET' : 'NOT SET');
  console.log('  Port:', PORT);
  console.log('===========================================');
});
