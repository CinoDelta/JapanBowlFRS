// Profile page: shows your own stats by default, or another player's stats
// when the URL has ?user=<their id>. Everything that comes from other users
// (names, deck names) is inserted with textContent, never as HTML.

const searchInput = document.getElementById('profileSearch');
const searchStatus = document.getElementById('searchStatus');
const searchResults = document.getElementById('searchResults');

const profileName = document.getElementById('profileName');
const profileSince = document.getElementById('profileSince');
const profileStatus = document.getElementById('profileStatus');
const profileBody = document.getElementById('profileBody');
const backToMine = document.getElementById('backToMine');
const statsNote = document.getElementById('statsNote');
const recentMatchesList = document.getElementById('recentMatches');
const deckListEl = document.getElementById('deckList');

const SEARCH_DELAY_MS = 300;

const OUTCOME_LABELS = {
    win: { symbol: '◯', text: 'Win', className: 'outcome-win' },
    loss: { symbol: '✕', text: 'Loss', className: 'outcome-loss' },
    tie: { symbol: '△', text: 'Tie', className: 'outcome-tie' },
    solo: { symbol: '—', text: 'Solo', className: 'outcome-solo' },
};

let myUserId = null;

function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function setText(id, value) {
    document.getElementById(id).textContent = value;
}

async function getSession() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session;
}

// ---- LOADING A PROFILE ----

// userId = null means "my own profile".
async function loadProfile(userId) {
    profileBody.style.display = 'none';
    profileStatus.style.display = 'block';
    profileStatus.textContent = 'Loading...';

    const session = await getSession();
    myUserId = session?.user.id ?? null;

    const viewingSomeoneElse = userId && userId !== myUserId;
    backToMine.style.display = viewingSomeoneElse && session ? 'block' : 'none';

    if (!userId && !session) {
        profileName.textContent = 'Your Profile';
        profileSince.textContent = '';
        profileStatus.replaceChildren(
            'Sign in to see your own stats, or search for a player above. ',
            Object.assign(document.createElement('a'), { href: 'login.html', textContent: 'Sign in' })
        );
        return;
    }

    let data;
    try {
        const res = userId
            ? await fetch(`/api/profile?id=${encodeURIComponent(userId)}`)
            : await fetch('/api/profile', { headers: { Authorization: `Bearer ${session.access_token}` } });
        data = await res.json();
    } catch (err) {
        console.error('profile load failed:', err);
        data = { ok: false };
    }

    if (!data.ok) {
        const messages = {
            user_not_found: "That player doesn't exist.",
            invalid_id: "That player doesn't exist.",
            not_authenticated: 'Your sign-in expired. Please sign in again.',
        };
        profileName.textContent = 'Profile';
        profileSince.textContent = '';
        profileStatus.textContent = messages[data.error] || 'Could not load this profile. Please try again.';
        return;
    }

    renderProfile(data.profile, !viewingSomeoneElse);
}

function renderProfile(profile, isMine) {
    const { user, decks, matches, recentMatches, statsAvailable } = profile;

    profileName.textContent = isMine ? `${user.username} (you)` : user.username;
    profileSince.textContent = user.memberSince ? `Member since ${formatDate(user.memberSince)}` : '';
    document.title = `${user.username} | Japan Bowl FRS`;

    setText('statDecks', decks.created);
    setText('statCards', decks.totalCards);
    setText('statDeckPlays', decks.timesPlayed);

    setText('statPlayed', matches.played);
    setText('statWins', matches.wins);
    setText('statLosses', matches.losses);
    setText('statTies', matches.ties);
    setText('statWinRate', matches.winRate === null ? '—' : `${matches.winRate}%`);
    setText('statAccuracy', matches.accuracy === null ? '—' : `${matches.accuracy}%`);
    setText('statPoints', matches.totalPoints);
    setText('statBest', matches.bestScore);
    setText('statBonus', matches.bonusCorrect);
    setText('statHosted', matches.hosted);

    statsNote.style.display = statsAvailable ? 'none' : 'block';
    statsNote.textContent = 'Match stats are not being recorded yet, so these show 0 for now.';

    renderRecentMatches(recentMatches);
    renderDecks(decks.list);

    profileStatus.style.display = 'none';
    profileBody.style.display = 'block';
}

function emptyItem(text) {
    const li = document.createElement('li');
    li.className = 'profile-list-empty';
    li.textContent = text;
    return li;
}

function renderRecentMatches(recent) {
    if (!recent.length) {
        recentMatchesList.replaceChildren(emptyItem('No finished matches yet.'));
        return;
    }

    recentMatchesList.replaceChildren(...recent.map((m) => {
        const outcome = OUTCOME_LABELS[m.outcome] || OUTCOME_LABELS.solo;

        const badge = document.createElement('span');
        badge.className = `outcome-badge ${outcome.className}`;
        badge.textContent = `${outcome.symbol} ${outcome.text}`;

        const deck = document.createElement('span');
        deck.className = 'profile-list-main';
        deck.textContent = m.deckName || 'Deleted deck';

        const details = document.createElement('span');
        details.className = 'profile-list-sub';
        const players = `${m.playerCount} player${m.playerCount === 1 ? '' : 's'}`;
        details.textContent = `${m.score} pts • ${players} • ${formatDate(m.finishedAt)}`;

        const li = document.createElement('li');
        li.append(badge, deck, details);
        return li;
    }));
}

function renderDecks(deckList) {
    if (!deckList.length) {
        deckListEl.replaceChildren(emptyItem('No decks uploaded yet.'));
        return;
    }

    deckListEl.replaceChildren(...deckList.map((d) => {
        const name = document.createElement('span');
        name.className = 'profile-list-main';
        name.textContent = d.name;

        const details = document.createElement('span');
        details.className = 'profile-list-sub';
        details.textContent = `${d.cardCount} cards • played ${d.matchesPlayed} time${d.matchesPlayed === 1 ? '' : 's'}`;

        const li = document.createElement('li');
        li.append(name, details);
        return li;
    }));
}

// ---- SWITCHING BETWEEN PROFILES ----

// Keeps the URL in step (?user=<id>) so a profile can be shared or bookmarked,
// and the back button works.
function showProfile(userId) {
    const url = userId ? `profile.html?user=${encodeURIComponent(userId)}` : 'profile.html';
    history.pushState({ userId }, '', url);
    loadProfile(userId);
    window.scrollTo({ top: profileName.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
}

window.addEventListener('popstate', () => {
    loadProfile(new URLSearchParams(location.search).get('user'));
});

backToMine.addEventListener('click', () => showProfile(null));

// ---- SEARCH ----

let searchTimer = null;
let latestSearch = 0;

async function runSearch(query) {
    const searchId = ++latestSearch;
    searchStatus.textContent = 'Searching...';

    let data;
    try {
        const res = await fetch(`/api/profile?search=${encodeURIComponent(query)}`);
        data = await res.json();
    } catch (err) {
        data = { ok: false };
    }

    // A newer search started while this one was loading.
    if (searchId !== latestSearch) return;

    if (!data.ok) {
        searchStatus.textContent = data.message || 'Search failed. Please try again.';
        searchResults.replaceChildren();
        return;
    }

    searchStatus.textContent = data.users.length ? '' : `No players found for "${query}".`;
    searchResults.replaceChildren(...data.users.map((u) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = u.id === myUserId ? `${u.username} (you)` : u.username;
        button.addEventListener('click', () => showProfile(u.id === myUserId ? null : u.id));

        const li = document.createElement('li');
        li.appendChild(button);
        return li;
    }));
}

searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();

    if (!query) {
        latestSearch++;
        searchStatus.textContent = '';
        searchResults.replaceChildren();
        return;
    }

    searchTimer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
});

loadProfile(new URLSearchParams(location.search).get('user'));
