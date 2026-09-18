const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// HEALTH CHECK
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Proxy server is running' });
});

// JOB CREATE
app.post('/proxy/jobs', async (req, res) => {
  try {
    const response = await fetch('https://api.tornadoapi.io/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.TORNADO_API_KEY
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    console.error('Proxy job error:', err.message);
    res.status(500).json({ message: 'Proxy server error: ' + err.message });
  }
});

// JOB STATUS CHECK
app.get('/proxy/jobs/:id', async (req, res) => {
  try {
    const response = await fetch(
      `https://api.tornadoapi.io/jobs/${encodeURIComponent(req.params.id)}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': process.env.TORNADO_API_KEY
        }
      }
    );

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    console.error('Proxy status error:', err.message);
    res.status(500).json({ message: 'Proxy server error: ' + err.message });
  }
});

// START SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
