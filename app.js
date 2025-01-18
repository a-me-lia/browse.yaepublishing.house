/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const cheerio = require('cheerio');
const { URL } = require('url');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------- Middleware ---------------------

// Security middleware to set various HTTP headers
app.use(helmet());

// Rate limiting middleware to prevent abuse
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

// Cookie parsing middleware
app.use(cookieParser());

// Body parsing middleware for handling POST requests if needed
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// --------------------- View Engine Setup ---------------------

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --------------------- Homepage Route ---------------------

// Homepage with Proxy Form
app.get('/', (req, res) => {
    res.render('index');
});

// --------------------- Utility Functions ---------------------

/**
 * Rewrites URLs in HTML content to route through the proxy.
 * @param {string} html - The original HTML content.
 * @param {URL} targetUrl - The URL object of the target website.
 * @returns {string} - The rewritten HTML content.
 */
function rewriteUrls(html, targetUrl) {
    const proxyBase = '/proxy?url=';
    const $ = cheerio.load(html);

    // Function to rewrite a single URL
    const rewriteUrl = (originalUrl) => {
        try {
            const absoluteUrl = new URL(originalUrl, targetUrl.origin);
            return `${proxyBase}${encodeURIComponent(absoluteUrl.href)}`;
        } catch (e) {
            return originalUrl; // Return original if URL parsing fails
        }
    };

    // Rewrite <a> tags
    $('a').each(function () {
        const href = $(this).attr('href');
        if (href) {
            const newHref = rewriteUrl(href);
            $(this).attr('href', newHref);
        }
    });

    // Rewrite <img>, <script>, <link> tags
    ['img', 'script', 'link'].forEach(tag => {
        $(tag).each(function () {
            const attr = tag === 'link' ? 'href' : 'src';
            const assetUrl = $(this).attr(attr);
            if (assetUrl) {
                const newUrl = rewriteUrl(assetUrl);
                $(this).attr(attr, newUrl);
            }
        });
    });

    // Handle forms by rewriting the action attribute
    $('form').each(function () {
        const action = $(this).attr('action') || targetUrl.href;
        const newAction = rewriteUrl(action);
        $(this).attr('action', newAction);
    });

    // Inject a script to handle dynamic content if necessary
    // This script can intercept XHR/fetch calls and rewrite URLs to go through the proxy
    const injectedScript = `
        <script>
            (function() {
                const proxyBase = '${proxyBase}';
                const originalFetch = window.fetch;
                window.fetch = function(input, init) {
                    let url = input;
                    try {
                        const parsedUrl = new URL(input, window.location.origin);
                        url = proxyBase + encodeURIComponent(parsedUrl.href);
                    } catch (e) {}
                    return originalFetch(url, init);
                };
                
                const originalXHROpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                    try {
                        const parsedUrl = new URL(url, window.location.origin);
                        arguments[1] = proxyBase + encodeURIComponent(parsedUrl.href);
                    } catch (e) {}
                    return originalXHROpen.apply(this, arguments);
                };
            })();
        </script>
    `;
    $('head').append(injectedScript);

    return $.html();
}

/**
 * Rewrites Set-Cookie headers to ensure cookies are correctly scoped.
 * @param {object} headers - The original headers from the target server.
 * @param {URL} targetUrl - The URL object of the target website.
 * @returns {object} - The modified headers with rewritten cookies.
 */
function rewriteSetCookie(headers, targetUrl) {
    if (!headers['set-cookie']) return headers;

    const cookies = headers['set-cookie'].map(cookie => {
        // Re-write the Domain attribute to match the proxy's domain
        return cookie.replace(/Domain=[^;]+;/i, `Domain=${targetUrl.hostname};`);
    });

    return { ...headers, 'set-cookie': cookies };
}

// --------------------- Proxy Endpoint ---------------------

app.use('/proxy', (clientRequest, clientResponse) => {
    let targetUrl = clientRequest.query.url;

    if (!targetUrl) {
        return clientResponse.status(400).send('Missing url parameter.');
    }

    try {
        // If the URL doesn't have a protocol, prepend 'http://'
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'http://' + targetUrl;
        }

        // Validate URL
        var parsedUrl = new URL(targetUrl);
    } catch (err) {
        return clientResponse.status(400).send('Invalid URL.');
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80);

    const options = {
        hostname: parsedUrl.hostname,
        port: port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: clientRequest.method,
        headers: {
            ...clientRequest.headers,
            host: parsedUrl.host,
            // To simplify response processing, remove 'accept-encoding'
            'accept-encoding': 'identity',
        },
    };

    const serverRequest = protocol.request(options, function (serverResponse) {
        const contentType = serverResponse.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html');

        // Handle Set-Cookie headers
        let responseHeaders = { ...serverResponse.headers };
        if (responseHeaders['set-cookie']) {
            responseHeaders = rewriteSetCookie(responseHeaders, parsedUrl);
        }

        if (isHtml) {
            let data = '';

            serverResponse.on('data', (chunk) => {
                data += chunk;
            });

            serverResponse.on('end', () => {
                try {
                    const rewrittenHtml = rewriteUrls(data, parsedUrl);
                    // Remove 'Content-Length' since we're modifying the body
                    delete responseHeaders['content-length'];
                    clientResponse.writeHead(serverResponse.statusCode, responseHeaders);
                    clientResponse.end(rewrittenHtml);
                } catch (err) {
                    console.error('Error rewriting HTML:', err);
                    clientResponse.status(500).send('Error processing HTML.');
                }
            });
        } else {
            // For non-HTML content, pipe directly
            clientResponse.writeHead(serverResponse.statusCode, responseHeaders);
            serverResponse.pipe(clientResponse, { end: true });
        }
    });

    // Handle serverRequest errors
    serverRequest.on('error', (err) => {
        console.error('Proxy error:', err);
        clientResponse.status(502).send('Bad Gateway.');
    });

    // Forward client request headers and body
    clientRequest.pipe(serverRequest, { end: true });
});

// --------------------- Start the Server ---------------------

app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});