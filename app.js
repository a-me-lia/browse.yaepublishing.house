/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const session = require('express-session');
const cheerio = require('cheerio'); // Added to parse and modify HTML

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
app.use('/proxy', (clientRequest, clientResponse) => {
    let targetUrl = clientRequest.query.url;
    let protocol = clientRequest.query.protocol || '';

    if (!targetUrl) {
        return clientResponse.status(400).send('Missing url parameter.');
    }

    // Append protocol if not included
    if (!/^https?:\/\//i.test(targetUrl)) {
        if (protocol) {
            targetUrl = protocol + targetUrl;
        } else {
            targetUrl = 'http://'+ targetUrl; // Default to HTTP if no protocol specified
        }
    }

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
            'Host': parsedUrl.hostname, // Use target hostname
            'Referer': parsedUrl.href,
            'Cookie': clientRequest.session.cookies || '',
        }
    };

    // Remove 'accept-encoding' to prevent compressed responses (simplifies parsing)
    delete options.headers['accept-encoding'];

    const serverRequest = protocolModule.request(options, function (serverResponse) {
        // Handle redirects
        if (serverResponse.statusCode >= 300 && serverResponse.statusCode < 400 && serverResponse.headers.location) {
            const redirectUrl = new URL(serverResponse.headers.location, parsedUrl);
            let proxiedRedirectUrl = `/proxy?url=${encodeURIComponent(redirectUrl.href)}`;
            if (protocol) {
                proxiedRedirectUrl += `&protocol=${encodeURIComponent(redirectUrl.protocol)}`;
            }
            return clientResponse.redirect(proxiedRedirectUrl);
        }

        // Store cookies in session
        if (serverResponse.headers['set-cookie']) {
            const newCookies = serverResponse.headers['set-cookie'].map(cookie => cookie.split(';')[0]);
            const existingCookies = clientRequest.session.cookies ? clientRequest.session.cookies.split('; ') : [];
            const mergedCookies = [...existingCookies, ...newCookies];
            // Remove duplicate cookies
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
                // Parse and modify the HTML content
                const $ = cheerio.load(body.toString());

                // Function to rewrite URLs to go through the proxy
                function rewriteUrl(url) {
                    try {
                        const absoluteUrl = new URL(url, parsedUrl);
                        let newUrl = `/proxy?url=${encodeURIComponent(absoluteUrl.href)}`;
                        if (protocol) {
                            newUrl += `&protocol=${encodeURIComponent(absoluteUrl.protocol)}`;
                        }
                        return newUrl;
                    } catch (e) {
                        return url; // Return original URL if parsing fails
                    }
                }

                // Rewrite all href attributes
                $('a[href]').each((i, elem) => {
                    const href = $(elem).attr('href');
                    if (href && !href.startsWith('javascript:')) {
                        $(elem).attr('href', rewriteUrl(href));
                    }
                });

                // Rewrite all src attributes
                $('[src]').each((i, elem) => {
                    const src = $(elem).attr('src');
                    if (src) {
                        $(elem).attr('src', rewriteUrl(src));
                    }
                });

                // Rewrite form actions
                $('form[action]').each((i, elem) => {
                    const action = $(elem).attr('action');
                    if (action) {
                        $(elem).attr('action', rewriteUrl(action));
                    }
                });

                // Remove Content-Length header since content size may have changed
                delete serverResponse.headers['content-length'];

                // Send the modified HTML to the client
                clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
                clientResponse.end($.html());
            } else {
                // For non-HTML content, send as-is
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