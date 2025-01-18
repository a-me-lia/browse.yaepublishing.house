// ... (other requires)
const cheerio = require('cheerio');

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

    // Determine protocol and port
    let protocolModule = http;
    if (parsedUrl.protocol === 'https:') {
        protocolModule = https;
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: clientRequest.method,
        headers: {
            ...clientRequest.headers,
            'Host': parsedUrl.hostname, // Use the target hostname in the Host header
            'Cookie': clientRequest.session.cookies || '', // Use session to store cookies
        }
    };

    const serverRequest = protocolModule.request(options, function (serverResponse) {
        // Handle redirects
        if (serverResponse.statusCode >= 300 && serverResponse.statusCode < 400 && serverResponse.headers.location) {
            const redirectUrl = new URL(serverResponse.headers.location, parsedUrl);
            const proxiedRedirectUrl = `/proxy?url=${encodeURIComponent(redirectUrl.href)}`;
            return clientResponse.redirect(proxiedRedirectUrl);
        }

        // Store cookies in session
        if (serverResponse.headers['set-cookie']) {
            clientRequest.session.cookies = serverResponse.headers['set-cookie'].join('; ');
        }

        let responseData = [];

        serverResponse.on('data', (chunk) => {
            responseData.push(chunk);
        });

        serverResponse.on('end', () => {
            const contentType = serverResponse.headers['content-type'] || '';
            const body = Buffer.concat(responseData);

            if (contentType.includes('text/html')) {
                // Parse HTML and modify links
                const $ = cheerio.load(body.toString());

                const baseUrl = parsedUrl.origin;

                // Update all href and src attributes
                $('a').each((i, elem) => {
                    const href = $(elem).attr('href');
                    if (href) {
                        try {
                            const newUrl = new URL(href, baseUrl);
                            $(elem).attr('href', `/proxy?url=${encodeURIComponent(newUrl.href)}`);
                        } catch (err) {
                            // Invalid URL, leave it as is
                        }
                    }
                });

                $('img, script, link').each((i, elem) => {
                    const attr = $(elem).is('link') ? 'href' : 'src';
                    const resource = $(elem).attr(attr);
                    if (resource) {
                        try {
                            const newUrl = new URL(resource, baseUrl);
                            $(elem).attr(attr, `/proxy?url=${encodeURIComponent(newUrl.href)}`);
                        } catch (err) {
                            // Invalid URL, leave it as is
                        }
                    }
                });

                // Update form actions
                $('form').each((i, elem) => {
                    const action = $(elem).attr('action');
                    if (action) {
                        try {
                            const newUrl = new URL(action, baseUrl);
                            $(elem).attr('action', `/proxy?url=${encodeURIComponent(newUrl.href)}`);
                        } catch (err) {
                            // Invalid URL, leave it as is
                        }
                    }
                });

                // Remove Content-Length header since content size might change
                delete serverResponse.headers['content-length'];

                // Send modified HTML to client
                clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
                clientResponse.end($.html());
            } else {
                // For non-HTML content, just pipe it directly
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