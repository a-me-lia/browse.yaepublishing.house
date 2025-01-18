const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = 3000; // Listen on port 3000

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Homepage with Proxy Form
app.get('/', (req, res) => {
    res.render('index');
});

// Proxy Endpoint
app.use('/proxy', (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('Missing url parameter.');
    }

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (err) {
        return res.status(400).send('Invalid URL.');
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: req.method,
        headers: req.headers
    };

    const proxyReq = protocol.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, {
            end: true
        });
    });

    proxyReq.on('error', (err) => {
        console.error(err);
        res.status(500).send('Proxy error.');
    });

    req.pipe(proxyReq, {
        end: true
    });
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});