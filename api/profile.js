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

function send(res, statusCode, body) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEARCH_RESULTS = 20;
const USERS_PER_PAGE = 1000;
const MAX_USER_PAGES = 10;
const RECENT_MATCHES = 8;

// The public name for a user. Same rule the nav bar uses: their full name if
// they set one, otherwise the part of their email before the @. The full
// email address is never sent to other users.
function usernameOf(user) {
    const fullName = user.user_metadata?.full_name;
    if (typeof fullName === 'string' && fullName.trim()) return fullName.trim();
    return (user.email || '').split('@')[0] || 'Player';
}

// Every user's id and public name. Supabase only hands out users a page at a
// time, so this walks the pages (capped, to keep a search fast).
async function listAllUsers() {
    const users = [];
    for (let page = 1; page <= MAX_USER_PAGES; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
        if (error) throw error;
        users.push(...data.users);
        if (data.users.length < USERS_PER_PAGE) break;
    }
    return users;
}

async function searchUsers(query) {
    const needle = query.trim().toLowerCase();
    const users = await listAllUsers();

    return users
        .map((u) => ({ id: u.id, username: usernameOf(u) }))
        .filter((u) => u.username.toLowerCase().includes(needle))
        // Names that start with the search come first, then alphabetical.
        .sort((a, b) => {
            const aStarts = a.username.toLowerCase().startsWith(needle) ? 0 : 1;
            const bStarts = b.username.toLowerCase().startsWith(needle) ? 0 : 1;
            return aStarts - bStarts || a.username.localeCompare(b.username);
        })
        .slice(0, MAX_SEARCH_RESULTS);
}

// Adds up a user's finished matches. 'solo' matches (only one team) are counted
// as played but not as a win or a loss, since there was nobody to beat.
function summarizeMatches(results) {
    const summary = {
        played: results.length,
        wins: 0,
        losses: 0,
        ties: 0,
        hosted: 0,
        totalPoints: 0,
        bestScore: 0,
        correctBuzzes: 0,
        totalBuzzes: 0,
        bonusCorrect: 0,
    };

    results.forEach((r) => {
        if (r.outcome === 'win') summary.wins++;
        if (r.outcome === 'loss') summary.losses++;
        if (r.outcome === 'tie') summary.ties++;
        if (r.was_host) summary.hosted++;
        summary.totalPoints += r.score || 0;
        summary.bestScore = Math.max(summary.bestScore, r.score || 0);
        summary.correctBuzzes += r.correct_buzzes || 0;
        summary.totalBuzzes += r.total_buzzes || 0;
        summary.bonusCorrect += r.bonus_correct || 0;
    });

    const decided = summary.wins + summary.losses + summary.ties;
    summary.winRate = decided ? Math.round((summary.wins / decided) * 100) : null;
    summary.accuracy = summary.totalBuzzes
        ? Math.round((summary.correctBuzzes / summary.totalBuzzes) * 100)
        : null;

    return summary;
}

async function buildProfile(user) {
    const [decksResult, resultsResult] = await Promise.all([
        supabase
            .from('decks')
            .select('id, name, cards, matches_played, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false }),
        supabase
            .from('match_results')
            .select('match_id, deck_name, team_number, score, outcome, player_count, team_count, was_host, correct_buzzes, total_buzzes, bonus_correct, finished_at')
            .eq('user_id', user.id)
            .order('finished_at', { ascending: false }),
    ]);

    if (decksResult.error) throw decksResult.error;

    // If match_results hasn't been created yet, still show the deck stats.
    if (resultsResult.error) console.error('match_results read error:', resultsResult.error);
    const results = resultsResult.data || [];

    const decks = (decksResult.data || []).map((d) => ({
        id: d.id,
        name: d.name,
        cardCount: Array.isArray(d.cards) ? d.cards.length : 0,
        matchesPlayed: d.matches_played || 0,
    }));

    return {
        user: {
            id: user.id,
            username: usernameOf(user),
            memberSince: user.created_at,
        },
        decks: {
            created: decks.length,
            totalCards: decks.reduce((sum, d) => sum + d.cardCount, 0),
            timesPlayed: decks.reduce((sum, d) => sum + d.matchesPlayed, 0),
            list: decks,
        },
        matches: summarizeMatches(results),
        recentMatches: results.slice(0, RECENT_MATCHES).map((r) => ({
            deckName: r.deck_name,
            outcome: r.outcome,
            score: r.score,
            teamNumber: r.team_number,
            playerCount: r.player_count,
            finishedAt: r.finished_at,
        })),
        statsAvailable: !resultsResult.error,
    };
}

// GET /api/profile                 -> your own profile (needs to be signed in)
// GET /api/profile?id=<user id>    -> anyone's profile
// GET /api/profile?search=<name>   -> users whose name contains <name>
module.exports = async (req, res) => {
    try {
        if (req.method !== 'GET') {
            send(res, 405, { error: 'method_not_allowed' });
            return;
        }

        const { id, search } = req.query;

        if (search !== undefined) {
            const query = String(search).trim();
            if (query.length < 1 || query.length > 40) {
                send(res, 400, { error: 'invalid_search', message: 'Search for 1-40 characters.' });
                return;
            }
            send(res, 200, { ok: true, users: await searchUsers(query) });
            return;
        }

        let user;
        if (id !== undefined) {
            if (!UUID_PATTERN.test(String(id))) {
                send(res, 400, { error: 'invalid_id' });
                return;
            }
            const { data, error } = await supabase.auth.admin.getUserById(String(id));
            if (error || !data?.user) {
                send(res, 404, { error: 'user_not_found' });
                return;
            }
            user = data.user;
        } else {
            user = await authenticate(req);
            if (!user) {
                send(res, 401, { error: 'not_authenticated' });
                return;
            }
        }

        send(res, 200, { ok: true, profile: await buildProfile(user) });
    } catch (err) {
        console.error('profile error:', err);
        send(res, 500, { error: 'internal_server_error' });
    }
};
