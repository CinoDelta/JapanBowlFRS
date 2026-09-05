const { createClient } = require('@supabase/supabase-js');

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

// POST   /api/join -> { code }  join an existing match's lobby
// DELETE /api/join -> { code }  leave a match you're currently in
module.exports = async (req, res) => {
    try {
        const user = await authenticate(req);
        if (!user) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not_authenticated' }));
            return;
        }

        const { code } = req.body;
        if (!code) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'missing_code' }));
            return;
        }

        const { data: match, error: matchError } = await supabase
            .from('matches')
            .select('id, status')
            .eq('code', code.toUpperCase())
            .single();

        if (matchError || !match) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'match_not_found' }));
            return;
        }

        if (req.method === 'POST') {
            if (match.status !== 'lobby') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_already_started' }));
                return;
            }

            const { error: joinError } = await supabase
                .from('match_players')
                .upsert(
                    {
                        match_id: match.id,
                        user_id: user.id,
                        display_name: user.user_metadata?.full_name ?? user.email,
                        team_number: 1,
                    },
                    { onConflict: 'match_id,user_id', ignoreDuplicates: true }
                );

            if (joinError) {
                console.error('join error:', joinError);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, code: code.toUpperCase() }));
            return;
        }

        if (req.method === 'DELETE') {
            const { error: leaveError } = await supabase
                .from('match_players')
                .delete()
                .eq('match_id', match.id)
                .eq('user_id', user.id);

            if (leaveError) {
                console.error('leave error:', leaveError);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
    } catch (err) {
        console.error('join error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
    }
};