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

const ANSWER_TIMEOUT_SECONDS = 15;

async function expireStaleBuzzes(matchId, questionIndex) {
    const cutoff = new Date(Date.now() - ANSWER_TIMEOUT_SECONDS * 1000).toISOString();
    await supabase
        .from('buzzes')
        .update({ result: 'incorrect', guess: '(no answer)' })
        .eq('match_id', matchId)
        .eq('question_index', questionIndex)
        .is('result', null)
        .lt('created_at', cutoff);
}

function getMainTimerForAnswerType(answerType, baseSeconds) {
    const japaneseTypes = ['JP', 'ひら', 'カナ', '漢'];
    const base = Number(baseSeconds) > 0 ? Number(baseSeconds) : 30;
    return japaneseTypes.includes(answerType) ? base * 2 : base;
}

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

// Works for toss-up cards and bonusQuestion objects alike, since both have
// "answers" and "answer-type".
function isCorrectAnswer(guess, card) {
    return card['answer-type'] !== 'EN'
        ? (card.answers || []).some((a) => normalize(a) === normalize(guess))
        : checkAnswerFuzzy(guess, card, 2);
}

const BONUS_POINTS = 10;
const BONUS_ANSWER_SECONDS = 15;
// Everyone sees "BONUS QUESTION FOR TEAM N!" for this long before the bonus starts.
const BONUS_LEAD_SECONDS = 3;
// Accept submissions this long after the deadline, to cover network lag.
const BONUS_GRACE_SECONDS = 1;

function getBonusReadTime(bonusCard, settings) {
    return bonusCard.readTime ?? settings?.earlyThresholdSeconds ?? 3;
}

// Read time + answer time. Japanese answers get twice as long, same as toss-ups.
function getBonusWindowSeconds(bonusCard, settings) {
    const japaneseTypes = ['JP', 'ひら', 'カナ', '漢'];
    const answerTime = japaneseTypes.includes(bonusCard['answer-type'])
        ? BONUS_ANSWER_SECONDS * 2
        : BONUS_ANSWER_SECONDS;
    return getBonusReadTime(bonusCard, settings) + answerTime;
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

            await expireStaleBuzzes(match.id, match.current_question_index);
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
            let card = null;
            if (deck) {
                card = deck.cards[match.question_order[match.current_question_index]];
                if (card?.readTime !== undefined) {
                    readTime = card.readTime;
                }
            }

            const elapsedSeconds = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;

            // question_started_at is in the future during "GET READY".
            if (elapsedSeconds < 0) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'question_not_started' }));
                return;
            }

            // The client clock pauses for each buzz (about 10s to answer plus about 4s
            // of result screens), so allow 15s per earlier buzz on top of the window.
            const { count: priorBuzzes } = await supabase
                .from('buzzes')
                .select('id', { count: 'exact', head: true })
                .eq('match_id', match.id)
                .eq('question_index', match.current_question_index);

            const answerWindow = getMainTimerForAnswerType(card?.['answer-type'], match.settings.timeLimitSeconds);
            if (elapsedSeconds > readTime + answerWindow + (priorBuzzes || 0) * 15) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'time_up' }));
                return;
            }

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
                    const someoneElse = (buzzError.message || '').includes('buzzes_one_active_per_question');
                    res.statusCode = 409;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ 
                        error: someoneElse ? 'someone_answering' : 'already_buzzed' 
                    }));
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
                .select('id, deck_id, question_order, settings')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            await expireStaleBuzzes(match.id, parseInt(questionIndex, 10));
            // Get ALL buzzes for this question, ordered by time.
            const { data: buzzes, error: buzzError } = await supabase
                .from('buzzes')
                .select('user_id, team_number, guess, result, is_early, created_at, bonus_question, bonus_started_at, bonus_ends_at, bonus_guess, bonus_result, bonus_user_id')
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
            const userIds = [...new Set((buzzes || []).flatMap((b) => [b.user_id, b.bonus_user_id]).filter(Boolean))];
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

            let bonus = null;
            const bonusBuzz = (buzzes || []).find((b) => b.result === 'correct' && b.bonus_question);
            if (bonusBuzz) {
                const { data: deck } = await supabase
                    .from('decks')
                    .select('cards')
                    .eq('id', match.deck_id)
                    .single();

                const bonusCard = deck?.cards[match.question_order[parseInt(questionIndex, 10)]]?.bonusQuestion;
                if (bonusCard) {
                    const over = bonusBuzz.bonus_result !== null
                        || Date.now() >= new Date(bonusBuzz.bonus_ends_at).getTime();

                    bonus = {
                        teamNumber: bonusBuzz.team_number,
                        question: bonusCard.question,
                        answerType: bonusCard['answer-type'],
                        readTime: getBonusReadTime(bonusCard, match.settings),
                        startedAt: bonusBuzz.bonus_started_at,
                        endsAt: bonusBuzz.bonus_ends_at,
                        result: bonusBuzz.bonus_result,
                        guess: bonusBuzz.bonus_guess,
                        displayName: nameMap[bonusBuzz.bonus_user_id] || null,
                        points: BONUS_POINTS,
                        over,
                        // Same rule as toss-ups: the answer only leaves the server once it's over.
                        answer: over ? ((bonusCard.answers || [])[0] ?? null) : null,
                    };
                }
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                ok: true,
                buzzes: enriched,
                activeBuzz: activeBuzz ? { ...activeBuzz, displayName: nameMap[activeBuzz.user_id] || null } : null,
                answeredCorrectly,
                bonus,
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

            const { code, questionIndex, guess, bonus} = req.body;
            if (!code || questionIndex === undefined || typeof guess !== 'string') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_fields' }));
                return;
            }

            const { data: match, error: matchError } = await supabase
                .from('matches')
                .select('id, deck_id, question_order, settings')
                .eq('code', code.toUpperCase())
                .single();

            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            // ---- BONUS ANSWER ----
            if (bonus === true) {
                // The bonus hangs off the correct toss-up buzz for this question.
                const { data: tossUp } = await supabase
                    .from('buzzes')
                    .select('id, team_number, bonus_ends_at')
                    .eq('match_id', match.id)
                    .eq('question_index', questionIndex)
                    .eq('result', 'correct')
                    .eq('bonus_question', true)
                    .is('bonus_result', null)
                    .maybeSingle();

                if (!tossUp) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'no_active_bonus' }));
                    return;
                }

                const { data: player } = await supabase
                    .from('match_players')
                    .select('id, score, team_number')
                    .eq('match_id', match.id)
                    .eq('user_id', user.id)
                    .single();

                if (!player || player.team_number !== tossUp.team_number) {
                    res.statusCode = 403;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'not_your_bonus' }));
                    return;
                }

                if (Date.now() > new Date(tossUp.bonus_ends_at).getTime() + BONUS_GRACE_SECONDS * 1000) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'bonus_time_up' }));
                    return;
                }

                const { data: deck } = await supabase
                    .from('decks')
                    .select('cards')
                    .eq('id', match.deck_id)
                    .single();

                const bonusCard = deck?.cards[match.question_order[questionIndex]]?.bonusQuestion;
                if (!bonusCard) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }

                const bonusResult = isCorrectAnswer(guess, bonusCard) ? 'correct' : 'incorrect';

                // Only the first teammate to submit counts. Filtering on
                // bonus_result IS NULL means a second submission updates nothing.
                const { data: claimed, error: claimError } = await supabase
                    .from('buzzes')
                    .update({ bonus_result: bonusResult, bonus_guess: guess, bonus_user_id: user.id })
                    .eq('id', tossUp.id)
                    .is('bonus_result', null)
                    .select('id');

                if (claimError) {
                    console.error('bonus grade error:', claimError);
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_server_error' }));
                    return;
                }

                if (!claimed || claimed.length === 0) {
                    res.statusCode = 409;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'bonus_already_answered' }));
                    return;
                }

                const pointChange = bonusResult === 'correct' ? BONUS_POINTS : 0;
                if (pointChange !== 0) {
                    await supabase
                        .from('match_players')
                        .update({ score: player.score + pointChange })
                        .eq('id', player.id);
                }

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, result: bonusResult, pointChange, }));
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

            const isCorrect = isCorrectAnswer(guess, card);
            const result = isCorrect ? 'correct' : 'incorrect';

            let pointChange = 0;
            if (isCorrect) {
                pointChange = 5;
            } else if (buzz.is_early) {
                pointChange = -5;
            }

            // A correct toss-up on a card with a bonusQuestion opens the bonus
            // for the answering team. bonus_ends_at is the hard deadline that
            // match.js and every client go by.
            const hasBonus = isCorrect && !!card.bonusQuestion;
            let bonusFields = {};
            if (hasBonus) {
                const startsAt = Date.now() + BONUS_LEAD_SECONDS * 1000;
                const endsAt = startsAt + getBonusWindowSeconds(card.bonusQuestion, match.settings) * 1000;
                bonusFields = {
                    bonus_question: true,
                    bonus_started_at: new Date(startsAt).toISOString(),
                    bonus_ends_at: new Date(endsAt).toISOString(),
                };
            }

            // Update THIS specific buzz row by its id.
            const { error: updateBuzzError } = await supabase
                .from('buzzes')
                .update({ result, guess, ...bonusFields })
                .eq('id', buzz.id);

            let allWrong = false;
            if (!isCorrect) {
              const { data: graded } = await supabase
                    .from('buzzes')
                    .select('result')
                    .eq('match_id', match.id)
                    .eq('question_index', questionIndex)
                    .not('result', 'is', null);

                const { count: playerCount } = await supabase
                    .from('match_players')
                    .select('id', { count: 'exact', head: true })
                    .eq('match_id', match.id);

                allWrong = playerCount > 0 && (graded || []).length >= playerCount;
            }

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
            res.end(JSON.stringify({ ok: true, result, pointChange, bonusQuestion: hasBonus, allWrong}));
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