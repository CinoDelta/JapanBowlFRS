const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.JFRS_SUPABASE_URL,
    process.env.JFRS_SUPABASE_SECRET_KEY
);

function generateMatchCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1, easy to misread
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

async function authenticate(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return null;

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
}

// POST /api/matches         -> create a match: { deckId }
// GET  /api/matches?code=XX -> fetch a match + its players by join code
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            const user = await authenticate(req);
            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            const { deckId } = req.body;
            if (!deckId) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_deck_id' }));
                return;
            }

            let match = null;
            for (let attempt = 0; attempt < 5 && !match; attempt++) {
                const code = generateMatchCode();
                const { data, error } = await supabase
                    .from('matches')
                    .insert({
                        code,
                        host_user_id: user.id,
                        deck_id: deckId,
                        settings: {
                            timeLimitSeconds: 15,
                            earlyThresholdSeconds: 3,
                            teamsEnabled: false,
                            numTeams: null,
                            questionCount: null,
                        },
                    })
                    .select()
                    .single();

                if (!error) match = data;
            }

            if (!match) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'could_not_create_match' }));
                return;
            }

            const { error: playerError } = await supabase
                .from('match_players')
                .insert({
                    match_id: match.id,
                    user_id: user.id,
                    display_name: user.user_metadata?.full_name ?? user.email,
                    team_number: 1,
                });

            if (playerError) {
                console.error('failed to add host as player:', playerError);
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, code: match.code, matchId: match.id }));
            return;
        }

        if (req.method === 'GET') {
            const { code } = req.query;
            if (!code) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_code' }));
                return;
            }

            const { data: match, error } = await supabase
                .from('matches')
                .select('id, code, status, settings, deck_id, current_question_index, host_user_id')
                .eq('code', code.toUpperCase())
                .single();

            if (error || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            const { data: players, error: playersError } = await supabase
                .from('match_players')
                .select('user_id, display_name, team_number, score, connected')
                .eq('match_id', match.id);

            if (playersError) {
                console.error('failed to load players:', playersError);
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, match, players: players || [] }));
            return;
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
    } catch (err) {
        console.error('matches error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
    }
};