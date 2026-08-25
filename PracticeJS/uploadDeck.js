async function uploadDeck(deckObject) {
    const res = await fetch("/api/decks", {
        method: "POST",
        headers: {"Content-Type" : "application/json"},
        body: JSON.stringify(deckObject)
    })

    const data = await res.json();
    
    if(!res || !data.ok) {
        alert("Upload failed! " + data.error || 'Unknown error');
        return;
    }
    alert("Deck uploaded! " + data.id);
}