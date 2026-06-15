// ============================================================
// APP.JS — Core Application Logic
// AI Interview Prep Tool — Multi-Provider Support
// ============================================================

// === Application State ===
let selectedProvider = 'gemini';
let selectedModel = '';
let apiKey = '';
let resumeText = '';
let jobDescription = '';
let pastScorecard = '';
let targetQuestionCount = 10;
let currentQuestionNumber = 0;
let conversationHistory = [];  // Universal format: [{role, content}]
let transcript = '';           // Full text transcript for scorecard
let interviewTimerInterval = null;
let interviewStartTime = null;

// ============================================================
// DOM ELEMENTS
// ============================================================

const views = {
    setup: document.getElementById('setup-view'),
    interview: document.getElementById('interview-view'),
    scorecard: document.getElementById('scorecard-view')
};

const el = {
    // Setup
    providerSelect: document.getElementById('provider-select'),
    modelSelect: document.getElementById('model-select'),
    providerInfo: document.getElementById('provider-info'),
    apiKey: document.getElementById('api-key'),
    keyHint: document.getElementById('key-hint'),
    keyLink: document.getElementById('key-link'),
    resumeUpload: document.getElementById('resume-upload'),
    jobDescription: document.getElementById('job-description'),
    pastScorecard: document.getElementById('past-scorecard'),
    languageSelect: document.getElementById('language-select'),
    questionCount: document.getElementById('question-count'),
    startBtn: document.getElementById('start-btn'),

    // Interview
    transcriptMessages: document.getElementById('transcript-messages'),
    transcriptPanel: document.getElementById('transcript-panel'),
    interimText: document.getElementById('interim-text'),
    stateBadge: document.getElementById('state-badge'),
    timerDisplay: document.getElementById('timer-display'),
    questionCounter: document.getElementById('question-counter'),
    voiceOrb: document.getElementById('voice-orb'),
    orbCore: document.getElementById('orb-core'),
    bargeInToggle: document.getElementById('bargein-toggle'),
    autoSubmitToggle: document.getElementById('autosubmit-toggle'),
    endBtn: document.getElementById('end-btn'),
    textInput: document.getElementById('text-input-box'),
    sendBtn: document.getElementById('send-btn'),

    // Scorecard
    scorecardContent: document.getElementById('scorecard-content'),
    verdictContainer: document.getElementById('verdict-container'),
    downloadBtn: document.getElementById('download-btn'),
    restartBtn: document.getElementById('restart-btn'),

    // Loading
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text')
};


// ============================================================
// 1. INITIALIZATION — Provider & Model Setup
// ============================================================

function initProviderUI() {
    const providerList = getProviderList();

    // Populate provider dropdown
    el.providerSelect.innerHTML = providerList.map(p =>
        `<option value="${p.key}">${p.icon} ${p.name}</option>`
    ).join('');

    // Restore saved selection
    const savedProvider = localStorage.getItem('iv_provider');
    const savedKey = localStorage.getItem('iv_apikey');
    if (savedProvider && PROVIDERS[savedProvider]) {
        el.providerSelect.value = savedProvider;
    }
    if (savedKey) {
        el.apiKey.value = savedKey;
    }

    updateProviderUI();
}

function updateProviderUI() {
    selectedProvider = el.providerSelect.value;
    const provider = getProvider(selectedProvider);
    if (!provider) return;

    // Update model dropdown
    el.modelSelect.innerHTML = provider.models.map(m => {
        const badge = m.tier === 'free' ? ' ✦ FREE' : '';
        return `<option value="${m.id}">${m.name}${badge}</option>`;
    }).join('');

    // Restore saved model
    const savedModel = localStorage.getItem('iv_model_' + selectedProvider);
    if (savedModel) {
        const exists = provider.models.find(m => m.id === savedModel);
        if (exists) el.modelSelect.value = savedModel;
    }

    selectedModel = el.modelSelect.value;

    // Update provider info
    const badges = [];
    if (provider.freeAvailable) badges.push('<span class="badge-free">FREE TIER</span>');
    if (!provider.freeAvailable) badges.push('<span class="badge-paid">PAID ONLY</span>');
    if (!provider.corsSupported) badges.push('<span class="badge-cors-warn">⚠ CORS</span>');
    el.providerInfo.innerHTML = badges.join(' ');

    // Update key placeholder and link
    el.apiKey.placeholder = provider.keyPlaceholder || 'Enter your API key';
    el.keyLink.href = provider.keyUrl || '#';

    // Update key hint
    const providerName = provider.name;
    el.keyHint.innerHTML = `Stored in browser only. <a id="key-link" href="${provider.keyUrl}" target="_blank" rel="noopener">Get ${providerName} key →</a>`;
}

// Event listeners for provider/model changes
el.providerSelect.addEventListener('change', updateProviderUI);
el.modelSelect.addEventListener('change', () => {
    selectedModel = el.modelSelect.value;
});


// ============================================================
// 2. START INTERVIEW
// ============================================================

async function startInterview() {
    apiKey = el.apiKey.value.trim();
    jobDescription = el.jobDescription.value.trim();
    pastScorecard = el.pastScorecard.value.trim();
    preferredLanguage = el.languageSelect.value;
    targetQuestionCount = parseInt(el.questionCount.value, 10);
    selectedModel = el.modelSelect.value;
    selectedProvider = el.providerSelect.value;

    if (!apiKey) return alert('Please enter your API key.');
    if (!jobDescription) return alert('Please enter a job description or target role.');

    // Save selections to localStorage
    localStorage.setItem('iv_provider', selectedProvider);
    localStorage.setItem('iv_apikey', apiKey);
    localStorage.setItem('iv_model_' + selectedProvider, selectedModel);

    showLoading('Parsing Resume...');

    try {
        // Parse resume PDF
        const file = el.resumeUpload.files[0];
        if (file) {
            resumeText = await extractTextFromPDF(file, (progress) => {
                showLoading(`Parsing Resume... Page ${progress}`);
            });
        } else {
            resumeText = 'No resume provided.';
        }

        showLoading('Initializing Voice Engine...');
        await startVADEngine();

        // Build system prompt
        const langName = el.languageSelect.options[el.languageSelect.selectedIndex].text;
        let systemPrompt = `You are a professional, experienced interviewer conducting a realistic mock job interview.

TARGET ROLE / JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME:
${resumeText}

${pastScorecard ? `PREVIOUS SCORECARD (focus on weak areas):
${pastScorecard}` : ''}

INTERVIEW RULES:
1. Conduct a realistic job interview with exactly ${targetQuestionCount} questions.
2. Ask ONE question at a time. Wait for the candidate's response before proceeding.
3. Start by briefly introducing yourself (use a realistic name) and asking the candidate to introduce themselves.
4. Mix technical questions (based on JD and resume skills) with behavioral questions (STAR method).
5. Keep your responses CONCISE — max 2-3 sentences per turn. This is a spoken conversation.
6. Do NOT provide feedback during the interview. Save all evaluation for the scorecard.
7. If the candidate interrupts you, gracefully accommodate and let them speak.
8. After the final question, say "That concludes our interview. Thank you for your time."
9. Language: Conduct the interview in ${langName}.
10. Be warm but professional. Vary question difficulty.`;

        // Initialize conversation with system prompt
        conversationHistory = [
            { role: 'system', content: systemPrompt }
        ];

        currentQuestionNumber = 0;
        transcript = '';
        interviewStartTime = Date.now();

        switchView('interview');
        hideLoading();
        startInterviewTimer();
        updateQuestionCounter();

        // Get first AI message (greeting)
        await getAIResponse();

    } catch (error) {
        hideLoading();
        alert('Error starting interview: ' + error.message);
        console.error('[Start Error]:', error);
    }
}


// ============================================================
// 3. AI RESPONSE — Multi-Provider
// ============================================================

async function getAIResponse() {
    transitionTo(STATES.PROCESSING);

    try {
        const result = await callLLM(
            selectedProvider,
            apiKey,
            selectedModel,
            conversationHistory,
            { temperature: 0.7, maxTokens: 300 }
        );

        const aiText = result.text;

        // Add to conversation history (universal format)
        conversationHistory.push({
            role: 'assistant',
            content: aiText
        });

        // Update transcript
        transcript += 'AI: ' + aiText + '\n\n';
        appendTranscriptBubble('ai', aiText);

        // Check if AI asked a question (increment counter)
        if (aiText.includes('?')) {
            currentQuestionNumber++;
            updateQuestionCounter();
        }

        // Speak the response (voice engine handles state transitions)
        speak(aiText, () => {
            // Callback after TTS finishes — COOLDOWN→LISTENING happens automatically
        });

    } catch (error) {
        console.error('[AI Error]:', error);
        const providerName = getProvider(selectedProvider)?.name || selectedProvider;
        appendTranscriptBubble('ai',
            `[Error: ${error.message}]\n\nTroubleshooting:\n• Check your ${providerName} API key\n• Verify your internet connection\n• Try a different model or provider`
        );
        transitionTo(STATES.LISTENING);
    }
}


// ============================================================
// 4. SPEECH SUBMISSION HOOK — Called by voice-engine.js
// ============================================================

window.onSpeechSubmitted = (text) => {
    if (!text) return;

    // Add to conversation history (universal format)
    conversationHistory.push({
        role: 'user',
        content: text
    });

    // Check if interview should end
    if (currentQuestionNumber >= targetQuestionCount) {
        // Let AI give one final response then end
        getAIFinalResponse();
    } else {
        getAIResponse();
    }
};

async function getAIFinalResponse() {
    transitionTo(STATES.PROCESSING);

    try {
        // Add instruction to wrap up
        const wrapUpHistory = [...conversationHistory, {
            role: 'user',
            content: '[System: This was the final question. Please give a brief closing statement thanking the candidate.]'
        }];

        const result = await callLLM(
            selectedProvider,
            apiKey,
            selectedModel,
            wrapUpHistory,
            { temperature: 0.5, maxTokens: 200 }
        );

        const aiText = result.text;
        conversationHistory.push({ role: 'assistant', content: aiText });
        transcript += 'AI: ' + aiText + '\n\n';
        appendTranscriptBubble('ai', aiText);

        speak(aiText, () => {
            // After final AI speech, auto-end interview
            setTimeout(() => endInterview(true), 1000);
        });

    } catch (error) {
        console.error('[Final Response Error]:', error);
        endInterview(true);
    }
}


// ============================================================
// 5. END INTERVIEW & SCORECARD
// ============================================================

async function endInterview(skipConfirm = false) {
    if (!skipConfirm && !confirm('End interview and generate your scorecard?')) return;

    transitionTo(STATES.IDLE);
    stopInterviewTimer();
    showLoading('Generating Scorecard...');
    switchView('scorecard');

    const duration = interviewStartTime
        ? Math.round((Date.now() - interviewStartTime) / 60000)
        : 0;

    try {
        const scorecardPrompt = `You are an expert interviewer and career coach. Based on the following interview transcript, provide a detailed performance scorecard.

TARGET ROLE / JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME:
${resumeText}

INTERVIEW TRANSCRIPT:
${transcript}

INTERVIEW DURATION: ${duration} minutes
QUESTIONS ASKED: ${currentQuestionNumber}

FORMAT YOUR RESPONSE IN MARKDOWN:

# Interview Scorecard

## Overall Score: X/10

## Verdict: [Pass / Fail / Strong Hire / Needs Improvement]

## Key Strengths
- (bullet points)

## Areas for Improvement
- (bullet points)

## Question-by-Question Feedback
For each question asked, briefly analyze the candidate's response quality, depth, and relevance.

## Communication Skills
Rate the candidate's clarity, confidence, and articulation.

## Actionable Advice
Provide 3-5 concrete tips the candidate should work on before their real interview.`;

        const scorecardMessages = [
            { role: 'system', content: 'You are an expert interviewer providing a detailed scorecard.' },
            { role: 'user', content: scorecardPrompt }
        ];

        const result = await callLLM(
            selectedProvider,
            apiKey,
            selectedModel,
            scorecardMessages,
            { temperature: 0.3, maxTokens: 2000 }
        );

        const scorecardMarkdown = result.text;
        renderScorecard(scorecardMarkdown);
        hideLoading();

    } catch (error) {
        hideLoading();
        el.scorecardContent.innerHTML = `<div class="error-message">
            <h3>⚠️ Error generating scorecard</h3>
            <p>${error.message}</p>
            <p>Your interview transcript has been preserved. You can try downloading it.</p>
        </div>`;
    }
}

function renderScorecard(markdown) {
    // Use marked.js if available, otherwise basic formatter
    if (typeof marked !== 'undefined') {
        el.scorecardContent.innerHTML = marked.parse(markdown);
    } else {
        el.scorecardContent.innerHTML = formatMarkdownBasic(markdown);
    }

    // Extract verdict for badge
    const verdictMatch = markdown.match(/Verdict[:\s]*\*?\*?([^*\n]+)\*?\*?/i);
    if (verdictMatch) {
        const verdict = verdictMatch[1].trim();
        let verdictClass = 'pass';
        if (/fail/i.test(verdict)) verdictClass = 'fail';
        else if (/strong\s*hire/i.test(verdict)) verdictClass = 'strong-hire';
        else if (/needs?\s*improvement/i.test(verdict)) verdictClass = 'fail';

        el.verdictContainer.innerHTML = `<span class="verdict-badge ${verdictClass}">${verdict}</span>`;
    }

    // Extract score for display
    const scoreMatch = markdown.match(/Score[:\s]*(\d+)\s*\/\s*10/i);
    if (scoreMatch) {
        const score = parseInt(scoreMatch[1], 10);
        const scoreElement = document.createElement('div');
        scoreElement.className = 'score-gauge';
        scoreElement.innerHTML = `
            <span class="score-number">${score}</span>
            <span class="score-label">/ 10</span>
        `;
        el.verdictContainer.insertBefore(scoreElement, el.verdictContainer.firstChild);
    }
}


// ============================================================
// 6. DOWNLOAD SCORECARD
// ============================================================

function downloadScorecard() {
    const content = el.scorecardContent.innerText;
    const fullContent = `AI INTERVIEW PREP — SCORECARD
Generated: ${new Date().toLocaleString()}
Provider: ${getProvider(selectedProvider)?.name || selectedProvider}
Model: ${selectedModel}
Role: ${jobDescription.substring(0, 100)}

${'='.repeat(50)}

${content}

${'='.repeat(50)}

FULL TRANSCRIPT:

${transcript}`;

    const blob = new Blob([fullContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Interview_Scorecard_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}


// ============================================================
// 7. UI HELPERS
// ============================================================

function switchView(viewName) {
    Object.keys(views).forEach(key => {
        views[key].classList.add('hidden');
    });
    views[viewName].classList.remove('hidden');
}

function showLoading(text) {
    el.loadingText.innerText = text;
    el.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    el.loadingOverlay.classList.add('hidden');
}

function updateQuestionCounter() {
    el.questionCounter.textContent = `Q ${currentQuestionNumber}/${targetQuestionCount}`;
}


// ============================================================
// 8. INTERVIEW TIMER
// ============================================================

function startInterviewTimer() {
    updateTimerDisplay();
    interviewTimerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopInterviewTimer() {
    if (interviewTimerInterval) clearInterval(interviewTimerInterval);
}

function updateTimerDisplay() {
    if (!interviewStartTime) return;
    const elapsed = Math.floor((Date.now() - interviewStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    el.timerDisplay.textContent = `${mins}:${secs}`;
}


// ============================================================
// 9. VOICE ENGINE UI HOOKS
// ============================================================

// Visual Meter — drives the orb animation
window.updateVisualMeter = (rms) => {
    const scale = 1 + Math.min(rms * 8, 0.5); // Scale orb core: 1.0 to 1.5
    if (el.orbCore) {
        el.orbCore.style.transform = `scale(${scale})`;
    }
};

// Interim text display
window.updateInterimUI = (text) => {
    el.interimText.innerText = text;
};

window.clearInterimUI = () => {
    el.interimText.innerText = '';
};

// Transcript bubbles
window.appendTranscriptBubble = (role, text, isInterrupted = false) => {
    const bubble = document.createElement('div');
    const roleLabel = role === 'ai' ? 'AI Interviewer' : 'You';
    const roleClass = role === 'ai' ? 'ai' : 'candidate';

    bubble.className = `bubble ${roleClass} ${isInterrupted ? 'interrupted' : ''}`;
    bubble.innerHTML = `
        <div class="bubble-label">${roleLabel}</div>
        <div class="bubble-text">${escapeHtml(text)}</div>
    `;
    el.transcriptMessages.appendChild(bubble);
    el.transcriptPanel.scrollTop = el.transcriptPanel.scrollHeight;
};

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// FSM State changes — update UI
const originalTransitionTo = transitionTo;
window.transitionTo = (newState) => {
    originalTransitionTo(newState);

    // Update state badge
    el.stateBadge.innerText = newState.replace('_', ' ');
    el.stateBadge.className = `state-badge ${newState.toLowerCase().replace('_', '-')}`;

    // Update voice orb
    el.voiceOrb.setAttribute('data-state', newState.toLowerCase().replace('_', '-'));

    // Update text input state
    if (newState === STATES.LISTENING) {
        el.textInput.disabled = false;
        el.textInput.placeholder = 'Speak or type your answer...';
    } else if (newState === STATES.USER_SPEAKING) {
        el.textInput.disabled = false;
        el.textInput.placeholder = 'Speaking detected...';
    } else if (newState === STATES.PROCESSING) {
        el.textInput.disabled = true;
        el.textInput.placeholder = 'AI is thinking...';
    } else if (newState === STATES.AI_SPEAKING) {
        el.textInput.disabled = false;
        el.textInput.placeholder = 'You can interrupt by speaking loudly...';
    } else if (newState === STATES.COOLDOWN) {
        el.textInput.disabled = true;
        el.textInput.placeholder = 'Preparing to listen...';
    }
};

// Timer hook from voice engine
window.runTimer = (seconds) => {
    // Voice engine calls this for answer timeout — we track via interview timer instead
};

// Silence timeout hook
window.onSilenceTimeout = () => {
    appendTranscriptBubble('ai', '💡 It seems quiet. Take your time, or type your answer below if you prefer.');
};


// ============================================================
// 10. AUTO-SUBMIT TOGGLE
// ============================================================

if (el.autoSubmitToggle) {
    el.autoSubmitToggle.addEventListener('change', () => {
        autoSubmitEnabled = el.autoSubmitToggle.checked;
    });
}


// ============================================================
// 11. TEXT INPUT — Typing Mode
// ============================================================

el.textInput.addEventListener('focus', () => {
    if (typeof enableTypingMode === 'function') enableTypingMode();
});

el.textInput.addEventListener('blur', () => {
    if (!el.textInput.value.trim()) {
        if (typeof disableTypingMode === 'function') disableTypingMode();
    }
});

el.sendBtn.addEventListener('click', () => {
    if (el.textInput.value.trim()) {
        submitSpeech();
        if (typeof disableTypingMode === 'function') disableTypingMode();
    }
});

el.textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && el.textInput.value.trim()) {
        submitSpeech();
        if (typeof disableTypingMode === 'function') disableTypingMode();
    }
});


// ============================================================
// 12. BASIC MARKDOWN FORMATTER (fallback if marked.js not loaded)
// ============================================================

function formatMarkdownBasic(text) {
    return text
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/^\* (.*$)/gim, '<li>$1</li>')
        .replace(/^\- (.*$)/gim, '<li>$1</li>')
        .replace(/\*\*([^*]+)\*\*/gim, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/gim, '<em>$1</em>')
        .replace(/\n/gim, '<br>');
}


// ============================================================
// 13. EVENT LISTENERS — Buttons
// ============================================================

el.startBtn.addEventListener('click', startInterview);
el.endBtn.addEventListener('click', () => endInterview(false));
el.restartBtn.addEventListener('click', () => location.reload());
el.downloadBtn.addEventListener('click', downloadScorecard);


// ============================================================
// 14. INIT
// ============================================================

initProviderUI();
console.log('[App] AI Interview Prep Tool initialized. Multi-provider support active.');
