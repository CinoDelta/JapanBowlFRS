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

// POST  /api/buzzer -> { code }  buzz in for the current question
// GET   /api/buzzer?code=XX&questionIndex=N -> who (if anyone) has buzzed
// PATCH /api/buzzer -> { code, questionIndex, guess }  submit + grade an answer
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

            const { code } = req.body;
            if (!code) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_code' }));
                return;
            }

            const { data: match, error: matchError } = await supabase
                .from('matches')
                .select('id, status, current_question_index, question_started_at, settings')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match || match.status !== 'in_progress') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_active' }));
                return;
            }

            const { data: player, error: playerError } = await supabase
                .from('match_players')
                .select('team_number')
                .eq('match_id', match.id)
                .eq('user_id', user.id)
                .single();

            if (playerError || !player) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_in_match' }));
                return;
            }

            const elapsedSeconds = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;
            const isEarly = elapsedSeconds < match.settings.earlyThresholdSeconds;

            // match_id + question_index is the PRIMARY KEY on buzzes -- Postgres
            // itself only allows one such row to ever exist. If two players
            // buzz within the same millisecond, the database (not either
            // browser's clock) decides who wins: whichever insert commits
            // first succeeds, and the other fails with a unique-violation.
            const { data: buzz, error: buzzError } = await supabase
                .from('buzzes')
                .insert({
                    match_id: match.id,
                    question_index: match.current_question_index,
                    user_id: user.id,
                    team_number: player.team_number,
                    is_early: isEarly,
                })
                .select()
                .single();

            if (buzzError) {
                if (buzzError.code === '23505') { // Postgres's standard code for "unique_violation"
                    res.statusCode = 409;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'already_buzzed' }));
                    return;
                }
                console.error('buzz error:', buzzError);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, buzz }));
            return;
        }

        if (req.method === 'GET') {
            const { code, questionIndex } = req.query;
            if (!code || questionIndex === undefined) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_fields' }));
                return;
            }

            const { data: match, error: matchError } = await supabase
                .from('matches')
                .select('id')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            const { data: buzz, error: buzzError } = await supabase
                .from('buzzes')
                .select('user_id, team_number, guess, result, created_at, is_early')
                .eq('match_id', match.id)
                .eq('question_index', parseInt(questionIndex, 10))
                .maybeSingle();

            if (buzzError) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            let displayName = null;
            if (buzz) {
                const { data: playerRow } = await supabase
                    .from('match_players')
                    .select('display_name')
                    .eq('match_id', match.id)
                    .eq('user_id', buzz.user_id)
                    .single();
                displayName = playerRow?.display_name ?? null;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, buzz: buzz ? { ...buzz, displayName } : null }));
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

            const { code, questionIndex, guess } = req.body;
            if (!code || questionIndex === undefined || typeof guess !== 'string') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_fields' }));
                return;
            }

            const { data: match, error: matchError } = await supabase
                .from('matches')
                .select('id, deck_id, question_order')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            const { data: buzz, error: buzzFetchError } = await supabase
                .from('buzzes')
                .select('user_id, is_early, result')
                .eq('match_id', match.id)
                .eq('question_index', questionIndex)
                .single();

            if (buzzFetchError || !buzz) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'no_buzz_found' }));
                return;
            }

            if (buzz.user_id !== user.id) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_your_buzz' }));
                return;
            }

            if (buzz.result) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'already_answered' }));
                return;
            }

            const { data: deck, error: deckError } = await supabase
                .from('decks')
                .select('cards')
                .eq('id', match.deck_id)
                .single();

            if (deckError || !deck) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            const cardIndex = match.question_order[questionIndex];
            const card = deck.cards[cardIndex];

            const normalize = (s) => s.trim().toLowerCase();

            
            // no i didn't write this function myself. 
            function getLevenshteinDistance(str1, str2) {
                const track = Array(str2.length + 1).fill(null).map(() =>
                Array(str1.length + 1).fill(null));
                
                for (let i = 0; i <= str1.length; i += 1) {
                track[0][i] = i;
                }
                for (let j = 0; j <= str2.length; j += 1) {
                track[j][0] = j;
                }
            
                for (let j = 1; j <= str2.length; j += 1) {
                for (let i = 1; i <= str1.length; i += 1) {
                    const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                    track[j][i] = Math.min(
                    track[j][i - 1] + 1, // deletion
                    track[j - 1][i] + 1, // insertion
                    track[j - 1][i - 1] + indicator, // substitution
                    );
                }
                }
            
                return track[str2.length][str1.length];
            }
            function checkAnswer(userInput, card, tolerance = 2) {
                if (!userInput) return { correct: false, message: "No input provided." };

                let bestMatch = null;
                let lowestDistance = Infinity;
                let matchedCard = null;

                for (const validAnswer of card.answers) {
                    const normalizedValid = validAnswer.trim().toLowerCase();
                    
                    // Calculate distance
                    const distance = getLevenshteinDistance(normalizedInput, normalizedValid);
                    
                    // Keep track of the closest match found across ALL cards
                    if (distance < lowestDistance) {
                        lowestDistance = distance;
                        bestMatch = normalizedValid;
                        matchedCard = card;
                    }
                }

                //Determine if the closest match is within our typo tolerance
                if (lowestDistance <= tolerance) {
                    return true;
                } else {
                    return false;
                }
            }


            const isCorrect = 
            card['answer-type'] !== 'EN' ? 
            (card.answers || []).some((a) => normalize(a) === normalize(guess)) 
            : checkAnswer(normalize(guess), card, 2); // some leniency for english answers

            const result = isCorrect ? 'correct' : 'incorrect';
            // Correct always gains points. Wrong only costs points if it was
            // an early buzz (matching "lose points if wrong, but only if
            // they buzzered in early"); a late wrong answer costs nothing.
            let pointChange = 0;
            if (isCorrect) {
                pointChange = 10;
            } else if (buzz.is_early) {
                pointChange = -10;
            }

            const { error: updateBuzzError } = await supabase
                .from('buzzes')
                .update({ result, guess })
                .eq('match_id', match.id)
                .eq('question_index', questionIndex);

            if (updateBuzzError) {
                console.error('grade update error:', updateBuzzError);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            const { data: playerRow, error: playerFetchError } = await supabase
                .from('match_players')
                .select('id, score')
                .eq('match_id', match.id)
                .eq('user_id', user.id)
                .single();

            if (!playerFetchError && playerRow) {
                await supabase
                    .from('match_players')
                    .update({ score: playerRow.score + pointChange })
                    .eq('id', playerRow.id);
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, result, pointChange }));
            return;
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
    } catch (err) {
        console.error('buzzer error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
    }
};