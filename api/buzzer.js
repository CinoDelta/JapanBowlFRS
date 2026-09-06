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
// GET   /api/buzzer?code=XX&questionIndex=N -> active buzz + all resolved buzzes
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
                .select('id, status, current_question_index, question_started_at, settings, deck_id, question_order')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match || match.status !== 'in_progress') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_active' }));
                return;
            }

            // Check if someone is CURRENTLY answering (an unresolved buzz exists).
            // If so, nobody else can buzz until that person's answer is graded.
            const { data: activeBuzz } = await supabase
                .from('buzzes')
                .select('id, user_id')
                .eq('match_id', match.id)
                .eq('question_index', match.current_question_index)
                .is('result', null)
                .maybeSingle();

            if (activeBuzz) {
                res.statusCode = 409;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'someone_answering' }));
                return;
            }

            // Check if this question was already answered correctly by anyone.
            const { data: correctBuzz } = await supabase
                .from('buzzes')
                .select('id')
                .eq('match_id', match.id)
                .eq('question_index', match.current_question_index)
                .eq('result', 'correct')
                .maybeSingle();

            if (correctBuzz) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'question_already_answered' }));
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

            // Determine if this is an early buzz by comparing elapsed time
            // against the card's readTime (or the host's default threshold).
            const { data: deck } = await supabase
                .from('decks')
                .select('cards')
                .eq('id', match.deck_id)
                .single();

            let readTime = match.settings.earlyThresholdSeconds;
            if (deck) {
                const cardIndex = match.question_order[match.current_question_index];
                const card = deck.cards[cardIndex];
                if (card?.readTime !== undefined) {
                    readTime = card.readTime;
                }
            }

            const elapsedSeconds = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;
            const isEarly = elapsedSeconds < readTime;

            // The unique constraint (match_id, question_index, user_id)
            // prevents the same person buzzing twice on the same question.
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
                if (buzzError.code === '23505') {
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

            // Get ALL buzzes for this question, ordered by time.
            const { data: buzzes, error: buzzError } = await supabase
                .from('buzzes')
                .select('user_id, team_number, guess, result, is_early, created_at')
                .eq('match_id', match.id)
                .eq('question_index', parseInt(questionIndex, 10))
                .order('created_at', { ascending: true });

            if (buzzError) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            // The "active" buzz is the one with no result yet (someone currently answering).
            const activeBuzz = (buzzes || []).find((b) => b.result === null) || null;
            // A question is fully resolved if someone got it correct.
            const answeredCorrectly = (buzzes || []).some((b) => b.result === 'correct');

            // Look up display names for all buzzers in one query.
            const userIds = [...new Set((buzzes || []).map((b) => b.user_id))];
            let nameMap = {};
            if (userIds.length > 0) {
                const { data: players } = await supabase
                    .from('match_players')
                    .select('user_id, display_name')
                    .eq('match_id', match.id)
                    .in('user_id', userIds);
                if (players) {
                    players.forEach((p) => { nameMap[p.user_id] = p.display_name; });
                }
            }

            const enriched = (buzzes || []).map((b) => ({
                ...b,
                displayName: nameMap[b.user_id] || null,
            }));

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                ok: true,
                buzzes: enriched,
                activeBuzz: activeBuzz ? { ...activeBuzz, displayName: nameMap[activeBuzz.user_id] || null } : null,
                answeredCorrectly,
            }));
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

            // Find THIS user's unresolved buzz for this question.
            const { data: buzz, error: buzzFetchError } = await supabase
                .from('buzzes')
                .select('id, user_id, is_early, result')
                .eq('match_id', match.id)
                .eq('question_index', questionIndex)
                .eq('user_id', user.id)
                .is('result', null)
                .maybeSingle();

            if (buzzFetchError || !buzz) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'no_active_buzz' }));
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

            function getLevenshteinDistance(str1, str2) {
                const track = Array(str2.length + 1).fill(null).map(() =>
                    Array(str1.length + 1).fill(null));
                for (let i = 0; i <= str1.length; i += 1) track[0][i] = i;
                for (let j = 0; j <= str2.length; j += 1) track[j][0] = j;
                for (let j = 1; j <= str2.length; j += 1) {
                    for (let i = 1; i <= str1.length; i += 1) {
                        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                        track[j][i] = Math.min(
                            track[j][i - 1] + 1,
                            track[j - 1][i] + 1,
                            track[j - 1][i - 1] + indicator,
                        );
                    }
                }
                return track[str2.length][str1.length];
            }

            function checkAnswerFuzzy(userInput, card, tolerance) {
                for (const validAnswer of card.answers) {
                    const distance = getLevenshteinDistance(
                        normalize(userInput),
                        normalize(validAnswer)
                    );
                    if (distance <= tolerance) return true;
                }
                return false;
            }

            const isCorrect = card['answer-type'] !== 'EN'
                ? (card.answers || []).some((a) => normalize(a) === normalize(guess))
                : checkAnswerFuzzy(guess, card, 2);

            const result = isCorrect ? 'correct' : 'incorrect';

            let pointChange = 0;
            if (isCorrect) {
                pointChange = 10;
            } else if (buzz.is_early) {
                pointChange = -10;
            }

            // Update THIS specific buzz row by its id.
            const { error: updateBuzzError } = await supabase
                .from('buzzes')
                .update({ result, guess })
                .eq('id', buzz.id);

            if (updateBuzzError) {
                console.error('grade update error:', updateBuzzError);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            if (pointChange !== 0) {
                const { data: playerRow } = await supabase
                    .from('match_players')
                    .select('id, score')
                    .eq('match_id', match.id)
                    .eq('user_id', user.id)
                    .single();

                if (playerRow) {
                    await supabase
                        .from('match_players')
                        .update({ score: playerRow.score + pointChange })
                        .eq('id', playerRow.id);
                }
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