const {put, list} = require('@vercel/blob');


// POST -> Upload a new deck!

// GET -> list ALL decks

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            const deck = req.body;
        } else if (req.method === 'GET') {
            const deck = req.body;
            const { blobs } = await list({
                prefix: 'decks/'
            });
            console.log('blobs found:', blobs.map(b => b.pathname));
            const decks = await Promise.all(
                // going through the list of the decks--
                // .map applies a functinon to each blob and returns a new array with the new values
                // in this case, that value is a "Promise" value that we wait for
                // The "Promise.all" is waiting for the arroay of promises that this will return
                blobs.map(async (blob) => {
                    // the "blob" here is the file 
                    const id = blob.pathname.replace('decks/', '').replace('.json', ''); // decks/randomNonsense.json -> randomNonsense
                    /*
                     its not actually random nonsense, but it'll be the exact date, time + random number from 0 to 100,000 when the deck 
                     upload function is created
                    */
                    try {
                        const r = await fetch(blob.url);
                        const deck = await r.json();
                        
                        return {
                            id,
                            name: deck?.name ?? 'Untitled deck',
                            cardCount: Array.isArray(deck?.cards) ? deck.cards.length : 0,
                            url: blob.url,
                        };
                    } catch {
                        return {id, name: 'Untitled deck', cardCount: 0, url: blob.url};         
                    }
                })
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ok : true, decks}));
            return;
        }

    } catch (err) {
        console.error('decks error: ', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error'}));
    }
};