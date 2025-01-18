/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
// ... (other requires)
const cheerio = require('cheerio');
const session = require('express-session');

const app = express();
const PORT = 3000; // Listen on port 3000

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Use session middleware to maintain persistent sessions
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Homepage with Proxy Form
app.get('/', (req, res) => {
    res.render('index');
});


// Proxy Endpoint
app.use('/proxy/:encodedUrl(*)', (clientRequest, clientResponse) => {
    const encodedUrl = clientRequest.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (err) {
        return clientResponse.status(400).send('Invalid URL.');
    }

    const protocolModule = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: clientRequest.method,
        headers: {
            ...clientRequest.headers,
            'Host': parsedUrl.host,
            'Referer': parsedUrl.href,
            'Cookie': clientRequest.session.cookies || '',
        }
    };

    // Remove 'accept-encoding' to simplify response handling
    delete options.headers['accept-encoding'];

    const serverRequest = protocolModule.request(options, function (serverResponse) {
        // Handle redirects
        if (serverResponse.statusCode >= 300 && serverResponse.statusCode < 400 && serverResponse.headers.location) {
            const redirectUrl = new URL(serverResponse.headers.location, parsedUrl);
            const encodedRedirectUrl = encodeURIComponent(redirectUrl.href);
            const proxiedRedirectUrl = `/proxy/${encodedRedirectUrl}`;
            return clientResponse.redirect(proxiedRedirectUrl);
        }

        // Store cookies in session
        if (serverResponse.headers['set-cookie']) {
            const newCookies = serverResponse.headers['set-cookie'].map(cookie => cookie.split(';')[0]);
            const existingCookies = clientRequest.session.cookies ? clientRequest.session.cookies.split('; ') : [];
            const mergedCookies = [...existingCookies, ...newCookies];
            clientRequest.session.cookies = Array.from(new Set(mergedCookies)).join('; ');
        }

        let responseData = [];

        serverResponse.on('data', (chunk) => {
            responseData.push(chunk);
        });

        serverResponse.on('end', () => {
            const contentType = serverResponse.headers['content-type'] || '';
            const body = Buffer.concat(responseData);

            if (contentType.includes('text/html')) {
                const $ = cheerio.load(body.toString());

                // Function to rewrite URLs
                function rewriteUrl(url) {
                    try {
                        const absoluteUrl = new URL(url, parsedUrl);
                        const encodedUrl = encodeURIComponent(absoluteUrl.href);
                        return `/proxy/${encodedUrl}`;
                    } catch (err) {
                        return url; // Return original URL if invalid
                    }
                }

                // Update all href and src attributes
                $('[href]').each((i, elem) => {
                    const href = $(elem).attr('href');
                    if (href && !href.startsWith('javascript:')) {
                        $(elem).attr('href', rewriteUrl(href));
                    }
                });

                $('[src]').each((i, elem) => {
                    const src = $(elem).attr('src');
                    if (src) {
                        $(elem).attr('src', rewriteUrl(src));
                    }
                });

                // Update form actions
                $('form').each((i, elem) => {
                    const action = $(elem).attr('action');
                    if (action) {
                        $(elem).attr('action', rewriteUrl(action));
                    }
                });

                // Remove Content-Length header since content size might change
                delete serverResponse.headers['content-length'];

                // Send modified HTML to client
                clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
                clientResponse.end($.html());
            } else {
                // For non-HTML content, pipe the response directly
                clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
                clientResponse.end(body);
            }
        });
    });

    serverRequest.on('error', (err) => {
        console.error(err);
        if (!clientResponse.headersSent) {
            clientResponse.status(500).send('Proxy error.');
        }
    });

    // Pipe the client request body to the server request
    clientRequest.pipe(serverRequest, { end: true });
});
// Start the Server
app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});