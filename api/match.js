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


//POST --> start a match
//GET --> get a matches current details


module.exports = async (res, req) => {
    try {
        if (req.method === 'POST') {

            const user = await authenticate(req);

            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            const { matchId } = req.query;

            const { data, error } = await supabase
                .from('matches')
                .update({status: 'ongoing'})
                .eq('id', matchId)

            if (error) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({error: 'internal_server_error'}));
                return;
            }
            

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ok: true}));

        }

        if (req.method === 'GET') {

        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({error: 'method_not_allowed'}));

    } catch (err) {
        console.error('error handling match:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
    }   
}