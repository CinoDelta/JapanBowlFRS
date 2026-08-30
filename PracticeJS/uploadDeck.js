async function uploadDeck(deckObject) {
    const { data: { session } } = await supabaseClient.auth.getSession();

    if (!session) {
        alert('Please sign in with Google first.');
        return;
    }

    const res = await fetch("/api/decks", {
        method: "POST",
        headers: {
            "Content-Type" : "application/json",
            "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(deckObject)
    })

    const data = await res.json();
    
    if(!res || !data.ok) {
        alert("Upload failed! " + data.error || 'Unknown error');
        return;
    }
    alert("Deck uploaded! " + data.id);
}


document.getElementById('uploadForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    //deckFile
    //uploadButton
    const fileInput = document.getElementById('deckFile');
    const statusEl = document.getElementById('uploadStatus');
    const file = fileInput.files[0];

    if(!file) {
        statusEl.textContent = 'Please choose a file! :(';
        return;
    }

    if (!file.name.endsWith('.json')) {
        statusEl.textContent = "This isn't json!!!";
        return;
    }

    statusEl.textContent = "Uploading...";

    let deck;

    try {
        const text = await file.text();
        deck = JSON.parse(text);
    } catch (err) {
        statusEl.textContent = "This file is unfortunately not valid JSON.";
        return;
    }

    if (typeof deck.name !== 'string' || !Array.isArray(deck.cards)) {
        statusEl.textContent = 'Invalid deck format -- expected {name, cards: []}';
        return;
    }

    console.log(`deck: ${deck}`);

    const { data: { session } } = await supabaseClient.auth.getSession();

    if (!session) {
        statusEl.textContent = 'Please sign in before uploading a deck!';
        return;
    }

    const res = await fetch('/api/decks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(deck),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
        statusEl.textContent = 'Upload failed: ' + (data.error || 'unknown error.');
        return;
    }

    statusEl.textContent = `Deck "${deck.name}" successfully uploaded!!!`;
    fileInput.value = '';
})