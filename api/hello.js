module.exports = (req, res) => {
    try {
        res.status(200).json({ok: true, message: 'Hello from Vercel function'});
    } catch (err) {
        console.error('Function error: ', err);
        res.status(500).json({error: 'internal_server_error'});
    }
};

