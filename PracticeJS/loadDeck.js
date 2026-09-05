
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
let imgCounter = 0;
const container = document.getElementById('deckListOne');
const deckListHeader = document.getElementById('deckSearchHeader');
const deckSearch = document.getElementById('deckSearch');
const deckName = document.getElementById('thisDeckName');
const deckCardCount = document.getElementById('thisDeckCardCount');
const singlePracticebutton = document.getElementById('singlePracticeSelect');
const hostMatchButton = document.getElementById('hostMatchButton');

let clientSidedDecks = {}
let currentDeckId = 0;

async function loadDecks() {
    console.log("fetching");
    const res = await fetch('/api/decks');
    const data = await res.json();

    deckListHeader.textContent = "Looking for decks...";

    container.innerHTML = '';

    if (!data.ok || data.decks.length === 0) {
        const warning = document.createElement('option');
        warning.textContent = 'Sorry! The decks failed to load, or there are no decks available yet.';
        container.appendChild(warning);
        return;
    }
    container.innerHTML = '';
    // to do: load only 10 max decks at a time
    data.decks.forEach(deck => {
        const newDeckOption = document.createElement('option');
        newDeckOption.textContent = deck.name;
        newDeckOption.setAttribute("myDeckId", deck.id);
        container.appendChild(newDeckOption);
    });

    clientSidedDecks = data.decks;
    console.log("done");

    deckListHeader.textContent = "Public Deck List";
    
}

function filterList() {
    const filter = deckSearch.value.toLowerCase();
    const options = container.options;

    for (let i = 0; i < options.length; i++) {
        const optionText = options[i].textContent.toLowerCase();
        
        // 4. Check if the option text contains the search query
        if (optionText.indexOf(filter) > -1) {
        options[i].style.display = ""; // Show the option if it matches
        } else {
        options[i].style.display = "none"; // Hide the option if it doesn't match
        }
    }
}


function sakuraSwitch() {
    const sakuras = document.getElementsByClassName("sakura-image");

    for (let img of sakuras) {
        img.src = `images/sakura${imgCounter}.png`;
    }

    imgCounter ++;
    imgCounter = imgCounter > 1 ? 0 : imgCounter;
}

let ellipsisInterval;


function satisfyingEllipsisChange() {
    let number = 1;
    let textModes = ["Creating match.", "Creating match..", "Creating match..."];
    
    ellipsisInterval = setInterval(() => {
        hostMatchButton.textContent = textModes[number];
        number++;
        number = number > 2 ? 0 : number;
    }, 500);
    
}

function displayDeckInfo() {
    let selectedIndex = container.selectedIndex;
    let selectedOption = container.options[selectedIndex];

    let currentDeckId = selectedOption.getAttribute("myDeckId");

    let targetDeck = clientSidedDecks.find((deck) => deck.id === currentDeckId);
    

    deckCardCount.innerHTML = `<i>Card Count: </i> ${targetDeck.cardCount}`;
    deckName.innerHTML = `<i>Deck Name: </i><u>${targetDeck.name}</u>`;

    singlePracticebutton.onclick = () => {
        window.location.href = `singlePractice.html?id=${currentDeckId}`
    }

    hostMatchButton.onclick = async () => {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session) {
            hostMatchButton.textContent = "Please log in to host a match!";
            delay(2000).then(() => {
                hostMatchButton.textContent = "Host Team Match!";
            });
        }

        hostMatchButton.disabled = true;
        hostMatchButton.textContent = "Creating match...";
        satisfyingEllipsisChange();

        const res = await fetch('/api/matches', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ deckId: currentDeckId }),
        });
        
        const data = await res.json();

        hostMatchButton.disabled = false;
        clearInterval(ellipsisInterval);

        hostMatchButton.textContent = "Host Team Match!";

        if (!data.ok) {
            alert('Failed to create a match:' + (data.error || 'unknown error'));
            return;
        }

        window.location.href =`hostLobby.html?code=${data.code}`;
    };


}


let sakuraInterval = null;

sakuraInterval = setInterval(sakuraSwitch, 500);
loadDecks();