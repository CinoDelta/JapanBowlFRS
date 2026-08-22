
/*
<div id="deck-list">Loading decks...</div>

<script>
async function loadDecks() {
    const res = await fetch('/api/decks');
    const data = await res.json();
    const container = document.getElementById('deck-list');
    container.innerHTML = '';

    if (!data.ok || data.decks.length === 0) {
        container.textContent = 'No decks uploaded yet.';
        return;
    }

    data.decks.forEach((deck) => {
        const btn = document.createElement('button');
        btn.textContent = `${deck.name} (${deck.cardCount} cards)`;
        btn.onclick = () => {
            // navigate to your practice page with the chosen deck's id
            window.location.href = `singlePractice.html?id=${deck.id}`;
        };
        container.appendChild(btn);
    });
}
loadDecks();
</script>
*/

async function loadDeck() {
    const res = await fetch('/api/decks');
    const data = await res.json();
    const container = document.getElementById('deck-list');
    const deckListHeader = document.getElementById('deckList')
    
}