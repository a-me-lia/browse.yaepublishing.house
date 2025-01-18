const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

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
app.use('/proxy', (req, res, next) => {
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

    // Create Proxy Middleware
    createProxyMiddleware({
        target: parsedUrl.origin,
        changeOrigin: true,
        pathRewrite: (path, req) => path.replace('/proxy', parsedUrl.pathname),
        onError: (err, req, res) => {
            console.error(err);
            res.status(500).send('Proxy error.');
        },
        logLevel: 'silent', // Change to 'debug' for verbose logs
    })(req, res, next);
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});