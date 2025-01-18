/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

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
app.use('/proxy', (clientRequest, clientResponse) => {
    const targetUrl = clientRequest.query.url;

    if (!targetUrl) {
        return clientResponse.status(400).send('Missing url parameter.');
    }

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (err) {
        return clientResponse.status(400).send('Invalid URL.');
    }

    const parsedHost = parsedUrl.hostname;
    let parsedPort;
    let parsedSSL;
    if (parsedUrl.protocol === 'https:') {
        parsedPort = 443;
        parsedSSL = https;
    } else if (parsedUrl.protocol === 'http:') {
        parsedPort = 80;
        parsedSSL = http;
    }

    const options = {
        hostname: parsedHost,
        port: parsedPort,
        path: parsedUrl.pathname + parsedUrl.search,
        method: clientRequest.method,
        headers: {
            'User-Agent': clientRequest.headers['user-agent'],
            'Cookie': clientRequest.headers['cookie'] || '', // Forward cookies for authentication
        }
    };

    const serverRequest = parsedSSL.request(options, function (serverResponse) {
        // Pipe the server response directly to the client response
        clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
        serverResponse.pipe(clientResponse, { end: true });

        // Handle redirects
        if (serverResponse.statusCode >= 300 && serverResponse.statusCode < 400 && serverResponse.headers.location) {
            const redirectUrl = new URL(serverResponse.headers.location, parsedUrl);
            const proxiedRedirectUrl = `/proxy?url=${encodeURIComponent(redirectUrl.href)}`;
            clientResponse.redirect(proxiedRedirectUrl);
        }
    });

    serverRequest.on('error', (err) => {
        console.error(err);
        clientResponse.status(500).send('Proxy error.');
    });

    // Pipe the client request body to the server request
    clientRequest.pipe(serverRequest, { end: true });
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});