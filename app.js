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
            ...clientRequest.headers,
            host: parsedHost
        }
    };

    const serverRequest = parsedSSL.request(options, function (serverResponse) {
        let body = [];
        serverResponse.on('data', function (chunk) {
            body.push(chunk);
        });

        serverResponse.on('end', function () {
            body = Buffer.concat(body);
            if (serverResponse.statusCode >= 300 && serverResponse.statusCode < 400 && serverResponse.headers.location) {
                // Handle redirects
                const redirectUrl = new URL(serverResponse.headers.location, parsedUrl);
                const proxiedRedirectUrl = `/proxy?url=${encodeURIComponent(redirectUrl.href)}`;
                clientResponse.redirect(proxiedRedirectUrl);
            } else {
                // Rewrite links in the response body to be proxied
                let bodyString = body.toString('utf8');
                bodyString = bodyString.replace(/href="(http[s]?:\/\/[^"]+)"/g, (match, p1) => {
                    return `href="/proxy?url=${encodeURIComponent(p1)}"`;
                });
                clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
                clientResponse.end(bodyString);
            }
        });
    });

    serverRequest.on('error', (err) => {
        console.error(err);
        clientResponse.status(500).send('Proxy error.');
    });

    serverRequest.end();
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});