const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.JFRS_SUPABASE_URL,
    process.env.JFRS_SUPABASE_SECRET_KEY
);

async function authenticate(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return null;

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
}

const MAX_NAME_LENGTH = 80;
const MAX_CARDS = 500;
const MAX_TEXT_LENGTH = 1000;
const MAX_ANSWERS = 10;
const ANSWER_TYPES = ['EN', 'JP', 'ひら', 'カナ', '漢', '123', 'ABC', 'RO'];

const isNonEmptyString = (v, max) =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// Returns a human-readable problem with the deck, or null if it is fine.
// Every match and practice session trusts this shape, so a malformed deck
// would otherwise break games for everyone who picks it.
function validateDeck(deck) {
    if (!deck || typeof deck !== 'object') return 'Expected { name, cards: [...] }';
    if (!isNonEmptyString(deck.name, MAX_NAME_LENGTH)) {
        return `Deck name must be 1-${MAX_NAME_LENGTH} characters.`;
    }
    if (!Array.isArray(deck.cards) || deck.cards.length === 0) return 'Deck must have at least one card.';
    if (deck.cards.length > MAX_CARDS) return `Decks are limited to ${MAX_CARDS} cards.`;

    for (let i = 0; i < deck.cards.length; i++) {
        const card = deck.cards[i];
        const where = `Card ${i + 1}`;
        if (!card || typeof card !== 'object') return `${where} is not an object.`;
        if (!isNonEmptyString(card.question, MAX_TEXT_LENGTH)) return `${where} needs a question.`;
        if (card.category !== undefined && typeof card.category !== 'string') return `${where} has an invalid category.`;
        if (!Array.isArray(card.answers) || card.answers.length === 0 || card.answers.length > MAX_ANSWERS
            || !card.answers.every((a) => isNonEmptyString(a, MAX_TEXT_LENGTH))) {
            return `${where} needs 1-${MAX_ANSWERS} text answers in "answers".`;
        }
        if (!ANSWER_TYPES.includes(card['answer-type'])) {
            return `${where} has an unknown answer-type (use one of ${ANSWER_TYPES.join(', ')}).`;
        }
        const img = card['img-link'];
        if (img !== undefined && img !== '' && !(typeof img === 'string' && /^https:\/\//.test(img))) {
            return `${where} img-link must be an https:// URL.`;
        }
    }
    return null;
}

// Keeps only the fields the game uses, so nothing extra gets stored.
function cleanCard(card) {
    const cleaned = {
        category: (card.category || '').trim(),
        question: card.question.trim(),
        answers: card.answers.map((a) => a.trim()),
        'answer-type': card['answer-type'],
    };
    if (card['img-link']) cleaned['img-link'] = card['img-link'];
    return cleaned;
}

module.exports = async (req, res) => {
    try {
        if (req.method === "POST") {

            const authHeader = req.headers.authorization || '';
            const token = authHeader.replace('Bearer ', '');

            if (!token) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            const { data: { user }, error: authError } = await supabase.auth.getUser(token);

            if (authError || !user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            const deck = req.body;
            const problem = validateDeck(deck);

            if (problem) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'invalid_deck', message: problem }));
                return;
            }

            const {data, error} = await supabase // object that contains data if succesful and error if not...
                .from('decks') // get it from the decks table
                .insert({
                    name: deck.name.trim(),
                    cards: deck.cards.map(cleanCard),
                    user_id: user.id,
                    uploader_name: user.user_metadata?.full_name ?? user.email,
                }) // insert a new row, give it a name and cards, id and time created is automatic
                .select() // select this row specifically... yes this row please...
                .single();

            console.log("POST AWAIT")

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
                    .select('id, name, cards, user_id') // i only need these 3 specifc columns (seperated in csv format, remember!)
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
                .select('id, name, cards, uploader_name, user_id')
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
                uploaderName: row.uploader_name,
                userId: row.user_id,
            }));

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ok: true, decks}));
            return;
        } else if (req.method === "DELETE") {
            const user = await authenticate(req);
            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            const { deckId } = req.query;

            if (!deckId) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_deckId' }));
                return;
            }

            const { data: deck, error: deckError } = await supabase
                .from('decks')
                .select('id, user_id')
                .eq('id', deckId)
                .single();

            if (deckError || !deck) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'deck_not_found' }));
                return;
            }

            if (deck.user_id !== user.id) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_owner' }));
                return;
            }

            const { error: deleteError } = await supabase
                .from('decks')
                .delete()
                .eq('id', deckId);

            if (deleteError) {
                console.error('delete error:', deleteError);
                res.statusCode = deleteError.code === '23503' ? 409 : 500; // foreign key violation or internal server error
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: deleteError.code === '23503' ? 'deck_in_use' : 'internal_server_error' }));
                return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({error: "method not allowed!! tsk tsk tsk"}));

    } catch (err) {
        console.error('decks error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({error: 'internal_server_error'}));
    }

};