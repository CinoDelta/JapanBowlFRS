const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.JFRS_SUPABASE_URL,
    process.env.JFRS_SUPABASE_SECRET_KEY
);

module.exports = async (req, res) => {
    try {
        if (req.method === "POST") {
        
            const deck = req.body;
            
            if (!deck || !Array.isArray(deck.cards) || typeof deck.name !== 'string') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'invalid_deck', message: 'Expected { name, cards: [...] }' }));
                return;
            }

            const {data, error} = await supabase // object that contains data if succesful and error if not...
                .from('decks') // get it from the decks table
                .insert({name: deck.name, cards: deck.cards}) // insert a new row, give it a name and cards, id and time created is automatic
                .select() // select this row specifically... yes this row please...
                .single();


            if (error) {
                console.log(`ERROR IS ${error}`);
                console.error('insert error:', error);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }


            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ok : true, id: data.id}));
            return;
        } else if (req.method === "GET") {
            const { id } = req.query
            

            // if we are looking for a specific deck
            if (id) {
                const { data, error } = await supabase
                    .from('decks') // from the table, decks
                    .select('id, name, cards') // i only need these 3 specifc columns (seperated in csv format, remember!)
                    .eq('id', id) // does the id match the id that came as part of our query?
                    .single(); // only one please
                
                if (error || !data) {
                    res.statusCode = 404;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({error: 'not_found'}));
                    return;
                }

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ok: true, deck: data})); // access the result with res.deck!
                return;
            }

            const {data, error} = await supabase 
                .from('decks')
                .select('id, name, cards')
                .order('created_at', {ascending: false});
            
            if (error) {
                console.error('list error:', error);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({error: 'internal-server-error :('}));
                return;
            }

            const decks = data.map((row) => ({
                id: row.id,
                name: row.name,
                cardCount: Array.isArray(row.cards) ? row.cards.length : 0,
            }));

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ok: true, decks}));
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({error: "method not allowed!! tsk tsk tsk"}));

    } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({error: 'internal_server_error'}));
    }

};
