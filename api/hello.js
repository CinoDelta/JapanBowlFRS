module.exports = (req, res) => {
    try {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, message: 'Hello from Vercel function' }));
    } catch (err) {
        console.error('Function error: ', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
    }
};
