const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = 80;

// Set EJS as templating engine 
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Homepage with Proxy Form
app.get('/', (req, res) => {
    res.render('index');
});

// Proxy all non-homepage requests
app.use('/*', (req, res, next) => {
    // Skip proxying for homepage and static assets
    if (req.path === '/' || req.path.startsWith('/public')) {
        return next();
    }

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

    // Create proxy middleware dynamically
    const proxy = createProxyMiddleware({
        target: parsedUrl.origin,
        changeOrigin: true,
        secure: false,
        followRedirects: true,
        pathRewrite: (path) => {
            // Remove the /proxy prefix and url parameter
            return parsedUrl.pathname + parsedUrl.search;
        },
        onProxyRes: (proxyRes, req, res) => {
            // Modify response headers to handle CORS and security
            proxyRes.headers['access-control-allow-origin'] = '*';
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['content-security-policy'];
        },
        onError: (err, req, res) => {
            console.error('Proxy error:', err);
            res.status(500).send('Error accessing the requested URL');
        }
    });

    return proxy(req, res, next);
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});