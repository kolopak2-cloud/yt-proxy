// ============================================================
// youtubeHUB Proxy Backend v7.0 - youtubei.js (Pure JS)
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Innertube } = require('youtubei.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range']
}));
app.use(express.json({ limit: '10mb' }));

// ============ YOUTUBE CLIENT SETUP ============
let yt = null;
let ytReady = false;

async function initYoutube() {
  try {
    const cookieStr = process.env.YOUTUBE_COOKIES || '';
    console.log('[Init] Starting Innertube... cookie length:', cookieStr.length);
    
    yt = await Innertube.create({
      cookie: cookieStr || undefined,
      retrieve_player: false,
      generate_session_locally: true
    });
    
    ytReady = true;
    console.log('[Init] Innertube ready ✅');
  } catch (e) {
    console.error('[Init] Innertube failed:', e.message);
    ytReady = false;
  }
}

// Server start hote hi init karo
initYoutube();

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'youtubeHUB proxy',
    version: '7.0.0 (youtubei.js)',
    innertube: ytReady ? 'ready' : 'not ready',
    cookiesSet: !!process.env.YOUTUBE_COOKIES,
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

    // Agar Innertube ready nahi, to try karo
    if (!ytReady || !yt) {
      await initYoutube();
      if (!ytReady || !yt) {
        return res.status(503).json({
          error: 'YouTube client not ready',
          message: 'Please retry in a moment.'
        });
      }
    }

    // ============ Info fetch karo ============
    let info;
    try {
      info = await yt.getInfo(videoId);
    } catch (err) {
      console.error('[Job] getInfo failed:', err.message);
      // Ek baar phir try karo fresh client se
      ytReady = false;
      await initYoutube();
      return res.status(503).json({
        error: 'YouTube fetch failed',
        message: err.message
      });
    }

    const basicInfo = info.basic_info || {};
    const videoTitle = basicInfo.title || 'Video';
    const videoDuration = basicInfo.duration || 0;
    const thumbnails = basicInfo.thumbnail || [];
    const videoThumbnail = thumbnails.length > 0
      ? thumbnails[0].url
      : 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';

    const streamingData = info.streaming_data || {};
    const progressiveFormats = streamingData.formats || [];
    const adaptiveFormats = streamingData.adaptive_formats || [];

    let chosenUrl = null;
    let qualityLabel = '720p';
    let fileSize = 0;

    // ============ Format Selection ============
    if (format === 'mp3') {
      // Audio-only formats
      const audioFormats = adaptiveFormats.filter(f => f.has_audio && !f.has_video);
      
      if (audioFormats.length === 0) {
        return res.status(503).json({ error: 'No audio format available' });
      }

      // Sort by bitrate descending
      audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const targetBitrate = parseInt((audio_bitrate || '320k').replace('k', ''), 10) || 320;

      let chosen = audioFormats[0];
      for (const f of audioFormats) {
        if ((f.bitrate || 0) <= targetBitrate * 1000) {
          chosen = f;
          break;
        }
        chosen = f;
      }

      chosenUrl = chosen.url;
      fileSize = parseInt(chosen.content_length || 0, 10);
      qualityLabel = Math.round((chosen.bitrate || 128000) / 1000) + ' kbps';
    } else {
      // Video formats
      const targetRes = parseInt((max_resolution || '720').replace('p', ''), 10) || 720;

      // Progressive (video+audio) formats preferred
      let videoFormats = progressiveFormats.filter(f => f.has_video && f.has_audio);

      // Filter by resolution
      let filtered = videoFormats.filter(f => {
        const h = parseInt(f.quality_label || '0', 10) || f.height || 0;
        return h > 0 && h <= targetRes;
      });

      if (filtered.length > 0) videoFormats = filtered;

      // Sort by resolution desc
      videoFormats.sort((a, b) => {
        const ah = parseInt(a.quality_label || '0', 10) || a.height || 0;
        const bh = parseInt(b.quality_label || '0', 10) || b.height || 0;
        return bh - ah;
      });

      if (videoFormats.length > 0) {
        const chosen = videoFormats[0];
        chosenUrl = chosen.url;
        fileSize = parseInt(chosen.content_length || 0, 10);
        qualityLabel = chosen.quality_label || (chosen.height ? chosen.height + 'p' : targetRes + 'p');
      } else {
        // Fallback: video-only adaptive
        let adaptiveVideo = adaptiveFormats.filter(f => f.has_video && !f.has_audio);

        filtered = adaptiveVideo.filter(f => {
          const h = parseInt(f.quality_label || '0', 10) || f.height || 0;
          return h > 0 && h <= targetRes;
        });

        if (filtered.length > 0) adaptiveVideo = filtered;

        adaptiveVideo.sort((a, b) => (b.height || 0) - (a.height || 0));

        if (adaptiveVideo.length > 0) {
          const chosen = adaptiveVideo[0];
          chosenUrl = chosen.url;
          fileSize = parseInt(chosen.content_length || 0, 10);
          qualityLabel = chosen.quality_label || (chosen.height + 'p');
        }
      }

      if (!chosenUrl) {
        return res.status(503).json({ error: 'No suitable video format available' });
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
      created_at: new Date().toISOString()
    };

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
  console.log('  youtubeHUB Proxy Server v7.0.0');
  console.log('  Using youtubei.js (pure JS)');
  console.log('  Port:', PORT);
  console.log('===========================================');
});
