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

const DEFAULT_SETTINGS = {
    timeLimitSeconds: 30,
    earlyThresholdSeconds: 3,
    teamsEnabled: false,
    numTeams: null,
    questionCount: null,
};

const isIntInRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Builds a clean settings object from what the client sent, or returns null
// if anything is out of range. Unknown keys are dropped.
function validateSettings(input) {
    if (!input || typeof input !== 'object') return null;
    const s = {
        timeLimitSeconds: input.timeLimitSeconds,
        earlyThresholdSeconds: input.earlyThresholdSeconds,
        teamsEnabled: input.teamsEnabled === true,
        numTeams: input.teamsEnabled === true ? input.numTeams : null,
        questionCount: input.questionCount ?? null,
    };
    if (!isIntInRange(s.timeLimitSeconds, 1, 600)) return null;
    if (!isIntInRange(s.earlyThresholdSeconds, 0, 120)) return null;
    if (s.teamsEnabled && !isIntInRange(s.numTeams, 1, 100)) return null;
    if (s.questionCount !== null && !isIntInRange(s.questionCount, 1, 10000)) return null;
    return s;
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
// PATCH /api/matches?code=XX -> change a match's settings
// DELETE /api/matches?code=XX -> end a match
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

            const { data: deck, error: deckError } = await supabase
                .from('decks')
                .select('id, matches_played')
                .eq('id', deckId)
                .maybeSingle();

            if (deckError || !deck) {
                if (deckError) console.error('deck lookup error:', deckError);
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'deck_not_found' }));
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
                        status: 'lobby',
                        settings: DEFAULT_SETTINGS,
                    })
                    .select()
                    .single();

                if (!error) {
                    match = data;
                } else if (error.code !== '23505') {
                    // Only a match-code collision is worth retrying.
                    console.error('match insert error:', error);
                    break;
                }
            }

            if (!match) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'could_not_create_match' }));
                return;
            }

            const { error: playedError } = await supabase
                .from('decks')
                .update({ matches_played: (deck.matches_played || 0) + 1 })
                .eq('id', deckId);

            if (playedError) {
                console.error('failed to increment matches_played:', playedError);
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

        if (req.method === 'PATCH') {
            const user = await authenticate(req);
            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }
 
            const { code, settings: rawSettings } = req.body;
            if (!code || !rawSettings) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_fields' }));
                return;
            }

            const settings = validateSettings(rawSettings);
            if (!settings) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'invalid_settings' }));
                return;
            }
 
            const { data: match, error: matchError } = await supabase
                .from('matches')
                .select('id, host_user_id, status')
                .eq('code', code.toUpperCase())
                .single();
 
            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }
 
            if (match.host_user_id !== user.id) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_host' }));
                return;
            }
 
            if (match.status !== 'lobby') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_already_started' }));
                return;
            }
 
            const { error: updateError } = await supabase
                .from('matches')
                .update({ settings })
                .eq('id', match.id);
 
            if (updateError) {
                console.error('settings update error:', updateError);
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
        
        if (req.method === 'DELETE') {
            const user = await authenticate(req);
            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }
 
            const { code } = req.query;
            if (!code) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_code' }));
                return;
            }
 
            const { data: match, error: matchError } = await supabase
                .from('matches')
                .select('id, host_user_id')
                .eq('code', code.toUpperCase())
                .single();
 
            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }
 
            if (match.host_user_id !== user.id) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_host' }));
                return;
            }

            // Child rows reference the match, so they have to go first or the
            // match delete is rejected by the foreign keys.
            for (const table of ['buzzes', 'match_players']) {
                const { error: childError } = await supabase
                    .from(table)
                    .delete()
                    .eq('match_id', match.id);

                if (childError) {
                    console.error(`could not clear ${table} for match ${match.id}:`, childError);
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }
            }

            const { data, error } = await supabase
                .from('matches')
                .delete()
                .eq('id', match.id)
                .select();
 
            if (error) {
                console.error(`could not delete match ${match.id}:`, error);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, deletedMatch: data }));
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