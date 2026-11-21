// How long a question takes to "read out", and how much of it is showing at
// any moment. Shared by the match page (match.html) and the API
// (api/match.js, api/buzzer.js), so the screen and the server always agree on
// when reading ends. That matters: the server uses it to decide whether a buzz
// was early and when a question is over.
//
// English is read a word at a time. Japanese has no spaces, so it is read a
// character at a time instead. Mixed text works too: "What does 頑張る mean?"
// reads What / does / 頑 / 張 / る / mean?

(function (root) {
    const WORD_SECONDS = 0.4;              // an English word
    const PERIOD_WORD_SECONDS = 0.6;       // an English word containing a "."
    const JAPANESE_CHAR_SECONDS = 0.15;    // one kanji, hiragana or katakana
    const JAPANESE_COMMA_SECONDS = 0.3;    // 、 ，
    const JAPANESE_STOP_SECONDS = 0.6;     // 。 ！ ？

    // Japanese punctuation, hiragana, katakana, kanji and full-width forms,
    // plus the rare kanji that sit above U+20000, such as 𠮟.
    const JAPANESE = '\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{3134F}';

    // Spaces, then single Japanese characters, then runs of anything else
    // (English words, numbers). Spaces are kept so the text can be rebuilt.
    const PIECE_PATTERN = new RegExp(`\\s+|[${JAPANESE}]|[^\\s${JAPANESE}]+`, 'gu');
    const JAPANESE_CHAR = new RegExp(`^[${JAPANESE}]$`, 'u');

    function splitIntoPieces(text) {
        return typeof text === 'string' ? (text.match(PIECE_PATTERN) || []) : [];
    }

    function isSpace(piece) {
        return piece.trim() === '';
    }

    function getPieceSeconds(piece) {
        if (isSpace(piece)) return 0;
        if (JAPANESE_CHAR.test(piece)) {
            if ('、，'.includes(piece)) return JAPANESE_COMMA_SECONDS;
            if ('。！？'.includes(piece)) return JAPANESE_STOP_SECONDS;
            return JAPANESE_CHAR_SECONDS;
        }
        // Punctuation on its own, like the "?" in 何ですか? typed on an
        // English keyboard, is a pause at the end of a sentence, not a word.
        if (/^[.!?…]+$/.test(piece)) return JAPANESE_STOP_SECONDS;
        return piece.includes('.') ? PERIOD_WORD_SECONDS : WORD_SECONDS;
    }

    // Total seconds to read the whole question.
    function getReadTime(text) {
        return splitIntoPieces(text).reduce((total, piece) => total + getPieceSeconds(piece), 0);
    }

    // The part of the question showing after `seconds` of reading. A piece
    // appears once its full time has passed.
    function getRevealedText(text, seconds) {
        let shown = '';
        let pendingSpace = '';
        let elapsed = 0;

        for (const piece of splitIntoPieces(text)) {
            if (isSpace(piece)) {
                pendingSpace += piece; // only shown if a later piece is shown
                continue;
            }
            const pieceSeconds = getPieceSeconds(piece);
            if (seconds < elapsed + pieceSeconds) break;
            elapsed += pieceSeconds;
            shown += (shown ? pendingSpace : '') + piece;
            pendingSpace = '';
        }
        return shown;
    }

    const ReadTiming = { splitIntoPieces, getPieceSeconds, getReadTime, getRevealedText };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ReadTiming;       // the API (Node)
    } else {
        root.ReadTiming = ReadTiming;      // the match page (browser)
    }
})(typeof window !== 'undefined' ? window : globalThis);
