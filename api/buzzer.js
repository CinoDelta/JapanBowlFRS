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

function staleCutoff() {
    return Date.now() - ANSWER_TIMEOUT_SECONDS * 1000;
}

async function expireStaleBuzzes(matchId, questionIndex) {
    await supabase
        .from('buzzes')
        .update({ result: 'incorrect', guess: '(no answer)' })
        .eq('match_id', matchId)
        .eq('question_index', questionIndex)
        .is('result', null)
        .lt('created_at', new Date(staleCutoff()).toISOString());
}

// Mirrors expireStaleBuzzes on rows read in parallel with it, so callers
// don't have to wait for the update before reading.
function applyStaleExpiry(buzzes) {
    const cutoff = staleCutoff();
    return (buzzes || []).map((b) =>
        b.result === null && new Date(b.created_at).getTime() < cutoff
            ? { ...b, result: 'incorrect', guess: '(no answer)' }
            : b
    );
}

// Pulls a single card out of the deck's cards array instead of the whole deck.
async function fetchCard(deckId, cardIndex) {
    if (cardIndex === undefined || cardIndex === null) return null;
    const { data, error } = await supabase
        .from('decks')
        .select(`card:cards->${Number(cardIndex)}`)
        .eq('id', deckId)
        .single();
    if (error) {
        console.error('card fetch error:', error);
        return null;
    }
    return data?.card ?? null;
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
const WORD_READ_INTERVAL_SECONDS = 0.4;
const PERIOD_WORD_READ_INTERVAL_SECONDS = 0.6;
// Everyone sees "BONUS QUESTION FOR TEAM N!" for this long before the bonus starts.
const BONUS_LEAD_SECONDS = 3;
// Accept submissions this long after the deadline, to cover network lag.
const BONUS_GRACE_SECONDS = 1;

function getWordReadDuration(word) {
    return typeof word === 'string' && word.includes('.')
        ? PERIOD_WORD_READ_INTERVAL_SECONDS
        : WORD_READ_INTERVAL_SECONDS;
}

function getQuestionReadTime(questionText) {
    const words = typeof questionText === 'string'
        ? questionText.split(/\s+/).filter(Boolean)
        : [];
    return words.reduce((total, word) => total + getWordReadDuration(word), 0);
}

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
            const { code } = req.body;
            if (!code) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_code' }));
                return;
            }

            // Every query below runs in one of three parallel rounds, since
            // each Supabase round trip is what makes a buzz feel slow.
            const [user, { data: match, error: matchError }] = await Promise.all([
                authenticate(req),
                supabase
                    .from('matches')
                    .select('id, status, current_question_index, question_started_at, settings, deck_id, question_order')
                    .eq('code', code.toUpperCase())
                    .single(),
            ]);

            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            if (matchError || !match || match.status !== 'in_progress') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_active' }));
                return;
            }

            // Measure elapsed time as soon as the match is known, so the
            // other lookups don't count against the player.
            const elapsedSeconds = (Date.now() - new Date(match.question_started_at).getTime()) / 1000;

            // question_started_at is in the future during "GET READY".
            if (elapsedSeconds < 0) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'question_not_started' }));
                return;
            }

            const questionIndex = match.current_question_index;
            const [, { data: rawBuzzes }, { data: player, error: playerError }, card] = await Promise.all([
                expireStaleBuzzes(match.id, questionIndex),
                supabase
                    .from('buzzes')
                    .select('result, created_at')
                    .eq('match_id', match.id)
                    .eq('question_index', questionIndex),
                supabase
                    .from('match_players')
                    .select('team_number')
                    .eq('match_id', match.id)
                    .eq('user_id', user.id)
                    .single(),
                fetchCard(match.deck_id, match.question_order?.[questionIndex]),
            ]);

            if (playerError || !player) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_in_match' }));
                return;
            }

            const buzzes = applyStaleExpiry(rawBuzzes);

            // Someone is CURRENTLY answering (an unresolved buzz exists), so
            // nobody else can buzz until that answer is graded.
            if (buzzes.some((b) => b.result === null)) {
                res.statusCode = 409;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'someone_answering' }));
                return;
            }

            if (buzzes.some((b) => b.result === 'correct')) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'question_already_answered' }));
                return;
            }

            // Match the fixed per-word reveal pace used by the client so the
            // server and the UI agree on when a buzz is "early".
            const readTime = getQuestionReadTime(card?.question);

            // The client clock pauses for each buzz (about 10s to answer plus about 4s
            // of result screens), so allow 15s per earlier buzz on top of the window.
            const priorBuzzes = buzzes.length;

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

            const qIndex = parseInt(questionIndex, 10);
            // Get ALL buzzes for this question, ordered by time. The expiry
            // update runs alongside and is mirrored locally on the rows.
            const [, { data: rawBuzzes, error: buzzError }] = await Promise.all([
                expireStaleBuzzes(match.id, qIndex),
                supabase
                    .from('buzzes')
                    .select('user_id, team_number, guess, result, is_early, created_at, bonus_question, bonus_started_at, bonus_ends_at, bonus_guess, bonus_result, bonus_user_id')
                    .eq('match_id', match.id)
                    .eq('question_index', qIndex)
                    .order('created_at', { ascending: true }),
            ]);

            if (buzzError) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            const buzzes = applyStaleExpiry(rawBuzzes);

            // The "active" buzz is the one with no result yet (someone currently answering).
            const activeBuzz = buzzes.find((b) => b.result === null) || null;
            // A question is fully resolved if someone got it correct.
            const answeredCorrectly = buzzes.some((b) => b.result === 'correct');
            const bonusBuzz = buzzes.find((b) => b.result === 'correct' && b.bonus_question);

            // Display names and the bonus card don't depend on each other.
            const userIds = [...new Set(buzzes.flatMap((b) => [b.user_id, b.bonus_user_id]).filter(Boolean))];
            const [players, bonusSourceCard] = await Promise.all([
                userIds.length > 0
                    ? supabase
                        .from('match_players')
                        .select('user_id, display_name')
                        .eq('match_id', match.id)
                        .in('user_id', userIds)
                        .then(({ data }) => data)
                    : null,
                bonusBuzz ? fetchCard(match.deck_id, match.question_order?.[qIndex]) : null,
            ]);

            const nameMap = {};
            (players || []).forEach((p) => { nameMap[p.user_id] = p.display_name; });

            const enriched = buzzes.map((b) => ({
                ...b,
                displayName: nameMap[b.user_id] || null,
            }));

            let bonus = null;
            if (bonusBuzz) {
                const bonusCard = bonusSourceCard?.bonusQuestion;
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
            const { code, questionIndex, guess, bonus} = req.body;
            if (!code || questionIndex === undefined || typeof guess !== 'string') {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing_fields' }));
                return;
            }

            const [user, { data: match, error: matchError }] = await Promise.all([
                authenticate(req),
                supabase
                    .from('matches')
                    .select('id, deck_id, question_order, settings')
                    .eq('code', code.toUpperCase())
                    .single(),
            ]);

            if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'not_authenticated' }));
                return;
            }

            if (matchError || !match) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'match_not_found' }));
                return;
            }

            // ---- BONUS ANSWER ----
            if (bonus === true) {
                // The bonus hangs off the correct toss-up buzz for this question.
                const [{ data: tossUp }, { data: player }, sourceCard] = await Promise.all([
                    supabase
                        .from('buzzes')
                        .select('id, team_number, bonus_ends_at')
                        .eq('match_id', match.id)
                        .eq('question_index', questionIndex)
                        .eq('result', 'correct')
                        .eq('bonus_question', true)
                        .is('bonus_result', null)
                        .maybeSingle(),
                    supabase
                        .from('match_players')
                        .select('id, score, team_number')
                        .eq('match_id', match.id)
                        .eq('user_id', user.id)
                        .single(),
                    fetchCard(match.deck_id, match.question_order?.[questionIndex]),
                ]);

                if (!tossUp) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'no_active_bonus' }));
                    return;
                }

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

                const bonusCard = sourceCard?.bonusQuestion;
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

            // THIS user's unresolved buzz, the card and their player row
            // don't depend on each other, so fetch them together.
            const [{ data: buzz, error: buzzFetchError }, card, { data: playerRow }] = await Promise.all([
                supabase
                    .from('buzzes')
                    .select('id, user_id, is_early, result')
                    .eq('match_id', match.id)
                    .eq('question_index', questionIndex)
                    .eq('user_id', user.id)
                    .is('result', null)
                    .maybeSingle(),
                fetchCard(match.deck_id, match.question_order?.[questionIndex]),
                supabase
                    .from('match_players')
                    .select('id, score')
                    .eq('match_id', match.id)
                    .eq('user_id', user.id)
                    .single(),
            ]);

            if (buzzFetchError || !buzz) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'no_active_buzz' }));
                return;
            }

            if (!card) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

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

            if (updateBuzzError) {
                console.error('grade update error:', updateBuzzError);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_server_error' }));
                return;
            }

            // If a player buzzes early and is wrong, the question is re-read from
            // the start for the remaining players. Reset the authoritative match
            // clock so all clients line up on the same restart point.
            if (result === 'incorrect' && buzz.is_early) {
                await supabase
                    .from('matches')
                    .update({ question_started_at: new Date(Date.now()).toISOString() })
                    .eq('id', match.id)
                    .eq('current_question_index', questionIndex);
            }

            // The score write and the "did everyone miss?" check run together.
            const [, allWrong] = await Promise.all([
                pointChange !== 0 && playerRow
                    ? supabase
                        .from('match_players')
                        .update({ score: playerRow.score + pointChange })
                        .eq('id', playerRow.id)
                    : null,
                isCorrect
                    ? false
                    : Promise.all([
                        supabase
                            .from('buzzes')
                            .select('result')
                            .eq('match_id', match.id)
                            .eq('question_index', questionIndex)
                            .not('result', 'is', null),
                        supabase
                            .from('match_players')
                            .select('id', { count: 'exact', head: true })
                            .eq('match_id', match.id),
                    ]).then(([{ data: graded }, { count: playerCount }]) =>
                        playerCount > 0 && (graded || []).length >= playerCount
                    ),
            ]);

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