/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const session = require('express-session');
const cheerio = require('cheerio');

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
    let protocol = clientRequest.query.protocol;

    if (!targetUrl) {
        return clientResponse.status(400).send('Missing url parameter.');
    }

    // If targetUrl doesn't have protocol, prepend protocol
    if (!/^https?:\/\//i.test(targetUrl)) {
        if (protocol) {
            targetUrl = protocol + targetUrl;
        } else {
            targetUrl = 'http://' + targetUrl;
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

    // Build headers, including forwarding necessary headers
    const headers = {
        ...clientRequest.headers,
        'Host': parsedUrl.hostname,
        'Referer': parsedUrl.href,
        'Cookie': clientRequest.session.cookies || '',
    };

    // Remove 'accept-encoding' to prevent compressed responses
    delete headers['accept-encoding'];

    // Modify 'Origin' header if present
    if (headers['origin']) {
        headers['origin'] = parsedUrl.origin;
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: clientRequest.method,
        headers: headers,
    };

    const serverRequest = protocolModule.request(options, function (serverResponse) {
        // Handle redirects
        if (serverResponse.statusCode >= 300 && serverResponse.statusCode < 400 && serverResponse.headers.location) {
            const redirectUrl = new URL(serverResponse.headers.location, parsedUrl);
            let proxiedRedirectUrl = `/proxy?url=${encodeURIComponent(redirectUrl.href)}`;
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

            // Remove security headers that may block content
            delete serverResponse.headers['content-security-policy'];
            delete serverResponse.headers['x-content-security-policy'];
            delete serverResponse.headers['x-webkit-csp'];
            delete serverResponse.headers['strict-transport-security'];
            delete serverResponse.headers['x-frame-options'];
            delete serverResponse.headers['x-xss-protection'];
            delete serverResponse.headers['x-content-type-options'];

            if (contentType.includes('text/html')) {
                // Parse and modify the HTML content
                let htmlContent = body.toString();

                // Remove <base> tags to prevent incorrect URL resolutions
                htmlContent = htmlContent.replace(/<base[^>]*>/gi, '');

                const $ = cheerio.load(htmlContent);

                // Function to rewrite URLs to go through the proxy
                function rewriteUrl(url) {
                    try {
                        const absoluteUrl = new URL(url, parsedUrl);
                        let newUrl = `/proxy?url=${encodeURIComponent(absoluteUrl.href)}`;
                        return newUrl;
                    } catch (e) {
                        return url; // Return original URL if parsing fails
                    }
                }

                // List of attributes containing URLs to rewrite
                const attributesToRewrite = ['href', 'src', 'action', 'data-href', 'data-src', 'data-url'];

                attributesToRewrite.forEach(attr => {
                    $(`[${attr}]`).each((i, elem) => {
                        const value = $(elem).attr(attr);
                        if (value && !value.startsWith('javascript:') && !value.startsWith('data:')) {
                            $(elem).attr(attr, rewriteUrl(value));
                        }
                    });
                });

                // Rewrite CSS URLs in style tags and attributes
                $('style').each((i, elem) => {
                    let cssContent = $(elem).html();
                    cssContent = cssContent.replace(/url\(['"]?([^'"\)]+)['"]?\)/g, (match, url) => {
                        return `url('${rewriteUrl(url)}')`;
                    });
                    $(elem).html(cssContent);
                });

                $('[style]').each((i, elem) => {
                    let styleContent = $(elem).attr('style');
                    styleContent = styleContent.replace(/url\(['"]?([^'"\)]+)['"]?\)/g, (match, url) => {
                        return `url('${rewriteUrl(url)}')`;
                    });
                    $(elem).attr('style', styleContent);
                });

                // Rewrite form actions
                $('form').each((i, elem) => {
                    const action = $(elem).attr('action');
                    if (!action || action.trim() === '') {
                        // If action is empty or not set, default to current URL
                        $(elem).attr('action', `/proxy?url=${encodeURIComponent(parsedUrl.href)}`);
                    } else {
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