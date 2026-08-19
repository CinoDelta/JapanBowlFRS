    // Javascript
    const cardDeck = [
         {
        category: "History",
        question: "What was the capital of Japan before Tokyo?",
        answer: "Kyoto"
    },
    {
        category: "Pop Culture",
        question: "Which studio produced 'Spirited Away'?",
        answer: "Studio Ghibli"
    },
    {
        category: "Geography",
        question: "What is the tallest mountain in Japan?",
        answer: "Mount Fuji"
    },
    {
        category: "History",
        question: "In which year did the Meiji Restoration begin?",
        answer: "1868"
    },
    {
        category: "Food",
        question: "What is the Japanese dish of vinegared rice with raw fish called?",
        answer: "Sushi"
    }
    ]

      let currentIndex = 0;
      let score = 0;
      // in the future i want this to be a variable that can be set by the user, but for now it is hardcoded to 15 seconds
      let timer = 15;
      let timerInterval = null;
      let isAnswered = false;
      let bonusPoints = 0;

      const categoryDisplay = document.getElementById('category-display');
      const questionDisplay = document.getElementById('question-display');
      const answerDisplay = document.getElementById('answer-display');
      const scoreDisplay = document.getElementById('score-display');
      const timerDisplay = document.getElementById('timer-display');
      const revealBtn = document.getElementById('reveal-btn');
      const correctBtn = document.getElementById('correct-btn');
      const wrongBtn = document.getElementById('wrong-btn');
      const nextBtn = document.getElementById('next-btn');

      const clocks = document.getElementsByClassName('timer-side-image');


    function loadQuestion() {

        console.log("Loading question at index: " + currentIndex);
        // Get the current card from the deck
        const card = cardDeck[currentIndex];
        
        // Update the display
        categoryDisplay.textContent = `${card.category}`;
        questionDisplay.textContent = card.question;
        answerDisplay.style.display = 'none';        // Hide answer
        answerDisplay.textContent = `Answer: ${card.answer}`;
        
        // Reset timer
        timer = 15;
        
        timerDisplay.textContent = `${timer}`;
        
        // Reset buttons
        revealBtn.style.display = 'inline-block';
        correctBtn.style.display = 'none';
        wrongBtn.style.display = 'none';
        nextBtn.style.display = 'none';
        
        isAnswered = false;

        // Start the countdown
        startTimer();
    }

    function startTimer() {

      // clear any other timer

      if (timerInterval) {
        clearInterval(timerInterval)
      }

      timerInterval = setInterval(function() {
        timer = timer - 1;
        timerDisplay.textContent = `${timer}`;

        // change the image source of the clock based on the timer value (use placeholders for now)
        if (clocks.length > 0) {
          for (let img of clocks) {
            if (timer % 2 == 0) {
              img.src = 'images/Clock1.png';
            } else {
              img.src = 'images/Clock2.png';
            }
          }
        }

        if (timer <= 0) {
          clearInterval(timerInterval);
          timerDisplay.textContent = `Times up!`;

          answerDisplay.style.display = 'block';

          revealBtn.style.display = 'none';
          correctBtn.style.display = 'inline-block';
          wrongBtn.style.display = 'inline-block';

          isAnswered = true;
        }

      }, 1000)
    }

    function markCorrect() {

      bonusPoints = 0;

      if (timer > 13) {
        bonusPoints = 3;
      } else if (timer > 7) {
        bonusPoints = 2;
      } else if (timer > 3) {
        bonusPoints = 1;
      } else {
        bonusPoints = 0;
      }

      score = score + 1 + bonusPoints ; // Add 1 point for correct answer and bonus based on remaining time
      scoreDisplay.textContent = `Score: ${score}`;
      afterAnswer();
    }

    function markWrong() {
      afterAnswer();
    }


    function revealAnswer() {
      if (isAnswered) return; // Already answered
      
      clearInterval(timerInterval); // Stop the timer
      answerDisplay.style.display = 'block'; // Show the answer
      
      // Hide reveal button, show correct/wrong buttons
      revealBtn.style.display = 'none';
      correctBtn.style.display = 'inline-block';
      wrongBtn.style.display = 'inline-block';
      if (bonusPoints > 0) {
        correctBtn.textContent = `O (+${bonusPoints} bonus points for time)`;
      } else {
        correctBtn.textContent = 'O';
      }

      isAnswered = true;
  }

    function afterAnswer() {
      correctBtn.style.display = 'none';
      wrongBtn.style.display = 'none';
      
      if (currentIndex < cardDeck.length - 1) {
        nextBtn.style.display = 'inline-block';
      } else {
        questionDisplay.textContent = "You completed the deck!"
        nextBtn.style.direction = 'none';
      }
    }

    function nextQuestion() {
      currentIndex = currentIndex + 1;
      if (currentIndex < cardDeck.length) {
        loadQuestion();
      }
    }

    revealBtn.addEventListener('click', revealAnswer);
    correctBtn.addEventListener('click', markCorrect);
    wrongBtn.addEventListener('click', markWrong);
    nextBtn.addEventListener('click', nextQuestion);


    loadQuestion();