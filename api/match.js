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

// Fisher-Yates shuffle: walk backward from the end, swapping each
// element with a random earlier-or-equal one. This gives every
// possible ordering an equal chance -- a naive "sort by Math.random()"
// is actually subtly biased.
function pickQuestionOrder(totalCards, questionCount) {
    const indices = Array.from({ length: totalCards }, (_, i) => i);

    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    const count = questionCount || totalCards;
    return indices.slice(0, count);
}

// Round-robin: player 0 -> team 1, player 1 -> team 2, ... wrapping
// back around with modulo. If teams are off, everyone is their own team.
function assignTeams(players, settings) {
    if (!settings.teamsEnabled) {
        return players.map((p, i) => ({ id: p.id, team_number: i + 1 }));
    }
    const numTeams = settings.numTeams || 1;
    return players.map((p, i) => ({ id: p.id, team_number: (i % numTeams) + 1 }));
}

// POST /api/match -> { code }  start the match (host only), or advance
//                    to the next question (any player, once resolved)
// GET  /api/match?code=XX -> the current question, WITHOUT the answer
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
                .select('id, host_user_id, status, deck_id, settings, current_question_index, question_order, question_started_at')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            if (match.status === 'lobby') {
                // Starting the match is host-only.
                if (match.host_user_id !== user.id) {
                    res.statusCode = 403;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'not_host' }));
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
                    res.end(JSON.stringify({ error: 'deck_not_found' }));
                    return;
                }

                const questionOrder = pickQuestionOrder(deck.cards.length, match.settings.questionCount);

                const { data: players, error: playersError } = await supabase
                    .from('match_players')
                    .select('id')
                    .eq('match_id', match.id);

                if (playersError) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }

                const assignments = assignTeams(players, match.settings);
                await Promise.all(assignments.map((p) =>
                    supabase.from('match_players').update({ team_number: p.team_number }).eq('id', p.id)
                ));

                const { error: updateError } = await supabase
                    .from('matches')
                    .update({
                        status: 'in_progress',
                        question_order: questionOrder,
                        current_question_index: 0,
                        question_started_at: new Date().toISOString(),
                    })
                    .eq('id', match.id);

                if (updateError) {
                    console.error('start match error:', updateError);
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, status: 'in_progress' }));
                return;
            }

            if (match.status === 'in_progress') {
                // Advancing isn't host-only -- but it can only happen once the
                // current question is actually resolved: someone answered, or
                // the time limit ran out with nobody buzzing at all.
                const { data: currentBuzz } = await supabase
                    .from('buzzes')
                    .select('result')
                    .eq('match_id', match.id)
                    .eq('question_index', match.current_question_index)
                    .maybeSingle();

                const elapsedSeconds = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;
                const timeIsUp = elapsedSeconds >= match.settings.timeLimitSeconds;
                const resolved = (currentBuzz && currentBuzz.result) || (!currentBuzz && timeIsUp);

                if (!resolved) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'question_not_resolved' }));
                    return;
                }

                const nextIndex = match.current_question_index + 1;

                if (nextIndex >= match.question_order.length) {
                    const { error: finishError } = await supabase
                        .from('matches')
                        .update({ status: 'finished' })
                        .eq('id', match.id);

                    if (finishError) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'internal_server_error' }));
                        return;
                    }

                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true, status: 'finished' }));
                    return;
                }

                const { error: advanceError } = await supabase
                    .from('matches')
                    .update({
                        current_question_index: nextIndex,
                        question_started_at: new Date().toISOString(),
                    })
                    .eq('id', match.id);

                if (advanceError) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, status: 'in_progress' }));
                return;
            }

            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'match_already_finished' }));
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
                .select('id, status, settings, deck_id, current_question_index, question_order, question_started_at')
                .eq('code', code.toUpperCase())
                .single();

            if (error || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            let question = null;

            if (match.question_order) {
                const { data: deck, error: deckError } = await supabase
                    .from('decks')
                    .select('cards')
                    .eq('id', match.deck_id)
                    .single();

                if (!deckError && deck) {
                    const cardIndex = match.question_order[match.current_question_index];
                    const card = cardIndex !== undefined ? deck.cards[cardIndex] : null;

                    // Only send what's needed to DISPLAY the question -- never
                    // the "answers" array. Anyone can open dev tools and read
                    // the network response, so the answer must never be sent
                    // to a client that isn't grading it server-side.
                    question = card ? {
                        category: card.category,
                        question: card.question,
                        answerType: card['answer-type'],
                        imgLink: card['img-link'] || null,
                    } : null;
                }
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                ok: true,
                status: match.status,
                currentQuestionIndex: match.current_question_index,
                totalQuestions: match.question_order ? match.question_order.length : 0,
                timeLimitSeconds: match.settings.timeLimitSeconds,
                questionStartedAt: match.question_started_at,
                question,
            }));
            return;
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
    } catch (err) {
        console.error('match error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
    }
};