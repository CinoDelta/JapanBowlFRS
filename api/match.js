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

function pickQuestionOrder(totalCards, questionCount) {
    const indices = Array.from({ length: totalCards }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const count = questionCount || totalCards;
    return indices.slice(0, count);
}

// Mirrors getMainTimerForAnswerType() in match.html. The host picks the answer
// window in the lobby (settings.timeLimitSeconds, 30 by default) and Japanese
// answers get twice that. Keep the two in step: if this is longer than what the
// client actually counts down, the answer reveal never unlocks.
function getMainTimerForAnswerType(answerType, baseSeconds) {
    const japaneseTypes = ['JP', 'ひら', 'カナ', '漢'];
    const base = Number(baseSeconds) > 0 ? Number(baseSeconds) : 30;
    return japaneseTypes.includes(answerType) ? base * 2 : base;
}

// Adds every player's score onto their team's total and works out who is on
// top. Teams come off the players themselves rather than settings.numTeams,
// because when teams are disabled every player is their own team and numTeams
// is null.
function computeStandings(players) {
    const teamScores = {};

    (players || []).forEach((p) => {
        if (p.team_number === null || p.team_number === undefined) return;
        teamScores[p.team_number] = (teamScores[p.team_number] || 0) + (p.score || 0);
    });

    let highestScore = null;
    let leaders = [];

    Object.keys(teamScores).forEach((key) => {
        const teamNumber = Number(key);
        const score = teamScores[key];

        if (highestScore === null || score > highestScore) {
            highestScore = score;
            leaders = [teamNumber];
        } else if (score === highestScore) {
            leaders.push(teamNumber);
        }
    });

    leaders.sort((a, b) => a - b);

    return {
        teamScores,
        highestScore: highestScore === null ? 0 : highestScore,
        // Exactly one leader means a winner; more than one means a tie for first.
        winningTeam: leaders.length === 1 ? leaders[0] : null,
        tyingTeams: leaders.length > 1 ? leaders : [],
    };
}

// A question is over once someone got it right, once every player in the match
// has had their buzz graded, or once the whole read + answer window has elapsed
// (plus the time the client timer spends paused on each buzz attempt). Only
// then is it safe to hand the answer out to clients.
async function questionIsOver(match, question) {
    const { data: buzzes } = await supabase
        .from('buzzes')
        .select('result')
        .eq('match_id', match.id)
        .eq('question_index', match.current_question_index);

    const allBuzzes = buzzes || [];

    if (allBuzzes.some((b) => b.result === 'correct')) return true;
    if (allBuzzes.some((b) => b.result === null)) return false;

    const { count: playerCount } = await supabase
        .from('match_players')
        .select('id', { count: 'exact', head: true })
        .eq('match_id', match.id);

    if (playerCount && allBuzzes.length >= playerCount) return true;

    // The client timer only counts down while the question is open — it stops
    // for every buzz — so real elapsed time is always at least read + answer
    // window by the time a client sees TIME'S UP. That makes this a floor,
    // never an early reveal.
    const readTime = question?.readTime ?? match.settings.earlyThresholdSeconds ?? 3;
    const answerWindow = getMainTimerForAnswerType(question?.answerType, match.settings.timeLimitSeconds);
    const elapsed = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;

    return elapsed >= readTime + answerWindow;
}

function assignTeams(players, settings) {
    if (!settings.teamsEnabled) {
        return players.map((p, i) => ({ id: p.id, team_number: i + 1 }));
    }
    const numTeams = settings.numTeams || 1;
    return players.map((p, i) => ({ id: p.id, team_number: (i % numTeams) + 1 }));
}

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

                // Set question_started_at to 5 seconds from now, giving
                // every player's browser time to load match.html, fetch
                // data, and set up realtime before the read phase begins.
                const firstQuestionStart = new Date(Date.now() + 5000).toISOString();

                const { error: updateError } = await supabase
                    .from('matches')
                    .update({
                        status: 'in_progress',
                        question_order: questionOrder,
                        current_question_index: 0,
                        question_started_at: firstQuestionStart,
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
                // A question is resolved when:
                // 1. Someone answered correctly, OR
                // 2. The client says time is up (we verify server-side)
                //    AND nobody is currently mid-answer (no unresolved buzz).

                // Checking if its the first second 

                const { data: buzzes } = await supabase
                    .from('buzzes')
                    .select('result')
                    .eq('match_id', match.id)
                    .eq('question_index', match.current_question_index);

                const answeredCorrectly = (buzzes || []).some((b) => b.result === 'correct');
                const someoneAnswering = (buzzes || []).some((b) => b.result === null);

                // We can't perfectly verify "time is up" server-side because
                // the main timer pauses during each answer attempt. But we CAN
                // check a generous upper bound: question_started_at + readTime
                // + mainTimer + (10s per buzz attempt) should have elapsed.


                const elapsed = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;

                if (elapsed < 3) {
                    console.log(`ELAPSED TIME IS ${elapsed}`);
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({error: 'elapsed_time_insufficient_to_advance'}));
                    return;
                }

                if (!answeredCorrectly && someoneAnswering) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'someone_still_answering' }));
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

                    const {data: players, error: playersError} = await supabase
                        .from('match_players')
                        .select('team_number, score')
                        .eq('match_id', match.id);

                    if (playersError) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({error: 'internal_server_error'}));
                        return;
                    }

                    const standings = computeStandings(players);

                    // sending back the winning team to the client
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        ok: true,
                        status: 'finished',
                        winningTeam: standings.winningTeam,
                        tyingTeams: standings.tyingTeams,
                        teamScores: standings.teamScores,
                    }));
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
            const { code, reveal } = req.query;
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
            let card = null;

            if (match.question_order) {
                const { data: deck, error: deckError } = await supabase
                    .from('decks')
                    .select('cards')
                    .eq('id', match.deck_id)
                    .single();

                if (!deckError && deck) {
                    const cardIndex = match.question_order[match.current_question_index];
                    card = cardIndex !== undefined ? deck.cards[cardIndex] : null;

                    if (card) {
                        question = {
                            category: card.category,
                            question: card.question,
                            answerType: card['answer-type'],
                            readTime: card.readTime !== undefined
                                ? card.readTime
                                : match.settings.earlyThresholdSeconds,
                            imgLink: card['img-link'] || null,
                        };
                    }
                }
            }

            // The answer is only ever sent once the question is genuinely over,
            // so a player can't read it out of the network tab mid-question.
            let answer = null;
            if (reveal && card && (match.status === 'finished' || await questionIsOver(match, question))) {
                answer = (card.answers || [])[0] ?? null;
            }

            let winningTeam = null;
            let tyingTeams = [];
            if (match.status === 'finished') {
                const { data: players } = await supabase
                    .from('match_players')
                    .select('team_number, score')
                    .eq('match_id', match.id);

                const standings = computeStandings(players);
                winningTeam = standings.winningTeam;
                tyingTeams = standings.tyingTeams;
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
                answer,
                winningTeam,
                tyingTeams,
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