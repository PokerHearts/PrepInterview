// Main application logic for AI Interview Prep Tool

let apiKey = "";
let resumeText = "";
let jobDescription = "";
let conversationHistory = [];
let transcript = ""; // Full text transcript for scorecard generation

// DOM Elements
const views = {
    setup: document.getElementById('setup-view'),
    interview: document.getElementById('interview-view'),
    scorecard: document.getElementById('scorecard-view')
};

const elements = {
    apiKey: document.getElementById('api-key'),
    resumeUpload: document.getElementById('resume-upload'),
    jobDescription: document.getElementById('job-description'),
    languageSelect: document.getElementById('language-select'),
    startBtn: document.getElementById('start-btn'),
    endBtn: document.getElementById('end-btn'),
    sendBtn: document.getElementById('send-btn'),
    restartBtn: document.getElementById('restart-btn'),
    downloadBtn: document.getElementById('download-btn'),
    textInput: document.getElementById('text-input-box'),
    transcriptMessages: document.getElementById('transcript-messages'),
    interimText: document.getElementById('interim-text'),
    stateBadge: document.getElementById('state-badge'),
    visualizerBar: document.getElementById('visualizer-bar'),
    scorecardContent: document.getElementById('scorecard-content'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text')
};

// --- Initialization ---

elements.startBtn.addEventListener('click', startInterview);
elements.endBtn.addEventListener('click', endInterview);
elements.sendBtn.addEventListener('click', () => {
    if (elements.textInput.value.trim()) {
        submitSpeech();
    }
});
elements.textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') elements.sendBtn.click();
});
elements.restartBtn.addEventListener('click', () => location.reload());
elements.downloadBtn.addEventListener('click', downloadScorecard);

// --- Core Functions ---

async function startInterview() {
    apiKey = elements.apiKey.value.trim();
    jobDescription = elements.jobDescription.value.trim();
    preferredLanguage = elements.languageSelect.value;
    
    if (!apiKey) return alert("Please enter your Gemini API Key.");
    if (!jobDescription) return alert("Please enter a job description or target role.");
    
    showLoading("Parsing Resume...");
    
    try {
        const file = elements.resumeUpload.files[0];
        if (file) {
            resumeText = await extractTextFromPDF(file);
        } else {
            resumeText = "No resume provided.";
        }

        showLoading("Initializing Voice Engine...");
        await startVADEngine();
        
        // Setup initial conversation
        conversationHistory = [
            {
                role: "user",
                parts: [{ text: `System Prompt: You are a professional interviewer. 
                Target Role/JD: ${jobDescription}
                Candidate Resume: ${resumeText}
                
                Instructions:
                1. Conduct a realistic job interview.
                2. Ask one question at a time.
                3. Start by briefly introducing yourself and asking the candidate to introduce themselves.
                4. Focus on role-specific technical and behavioral questions based on the JD and Resume.
                5. Keep your responses concise (max 2-3 sentences) to facilitate a natural conversation.
                6. Do NOT provide feedback during the interview. Save it for the end.
                7. If the candidate asks a question, answer it and then ask your next interview question.
                8. Language: Please conduct the interview in ${elements.languageSelect.options[elements.languageSelect.selectedIndex].text}.` }]
            }
        ];

        switchView('interview');
        hideLoading();
        
        // Initial greeting
        await getAIResponse();

    } catch (error) {
        hideLoading();
        alert("Error starting interview: " + error.message);
    }
}

async function getAIResponse() {
    transitionTo(STATES.PROCESSING);
    
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: conversationHistory,
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 250,
                }
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        const aiText = data.candidates[0].content.parts[0].text;
        
        conversationHistory.push({
            role: "model",
            parts: [{ text: aiText }]
        });
        
        transcript += "AI: " + aiText + "\n\n";
        appendTranscriptBubble("AI", aiText);
        
        speak(aiText, () => {
            // Callback runs after TTS ends
            // Transition to LISTENING is handled by speak()'s COOLDOWN logic in voice-engine.js
        });

    } catch (error) {
        console.error("AI Error:", error);
        appendTranscriptBubble("AI", "[Error: Failed to get response from Gemini. Please check your API key and connection.]");
        transitionTo(STATES.LISTENING);
    }
}

// Hook called by voice-engine.js when speech is submitted
window.onSpeechSubmitted = (text) => {
    if (!text) return;
    
    conversationHistory.push({
        role: "user",
        parts: [{ text: text }]
    });
    
    getAIResponse();
};

async function endInterview() {
    if (!confirm("Are you sure you want to end the interview and generate your scorecard?")) return;
    
    transitionTo(STATES.IDLE);
    showLoading("Generating Scorecard...");
    switchView('scorecard');
    
    try {
        const scorecardPrompt = `You are an expert interviewer and career coach. Based on the following interview transcript, JD, and resume, provide a detailed scorecard.
        
        Target Role/JD: ${jobDescription}
        Candidate Resume: ${resumeText}
        
        Interview Transcript:
        ${transcript}
        
        Format your response in Markdown with the following sections:
        1. **Overall Score**: (0-10)
        2. **Verdict**: (Pass/Fail/Strong Hire)
        3. **Key Strengths**: (Bullet points)
        4. **Areas for Improvement**: (Bullet points)
        5. **Question-by-Question Feedback**: (Briefly analyze the candidate's answers)
        6. **Advice for the Candidate**: (Concrete tips for the real interview)`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: scorecardPrompt }] }],
                generationConfig: { temperature: 0.3 }
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        const scorecardMarkdown = data.candidates[0].content.parts[0].text;
        elements.scorecardContent.innerHTML = formatMarkdown(scorecardMarkdown);
        hideLoading();

    } catch (error) {
        hideLoading();
        elements.scorecardContent.innerHTML = `<p class="error">Error generating scorecard: ${error.message}</p>`;
    }
}

function downloadScorecard() {
    const content = elements.scorecardContent.innerText;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Interview_Scorecard_${new Date().toLocaleDateString().replace(/\//g, '-')}.txt`;
    a.click();
}

// --- UI Helpers ---

function switchView(viewName) {
    Object.keys(views).forEach(key => {
        views[key].classList.add('hidden');
    });
    views[viewName].classList.remove('hidden');
}

function showLoading(text) {
    elements.loadingText.innerText = text;
    elements.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    elements.loadingOverlay.classList.add('hidden');
}

// Override placeholders in voice-engine.js
window.updateVisualMeter = (rms) => {
    const percent = Math.min(rms * 500, 100); // Scale RMS to 0-100%
    elements.visualizerBar.style.width = percent + '%';
    
    // Change color based on voice activity
    if (rms > speechThreshold) {
        elements.visualizerBar.style.background = '#10b981'; // Green
    } else {
        elements.visualizerBar.style.background = '#4f46e5'; // Primary
    }
};

window.updateInterimUI = (text) => {
    elements.interimText.innerText = text;
};

window.clearInterimUI = () => {
    elements.interimText.innerText = "";
};

window.appendTranscriptBubble = (role, text, isInterrupted = false) => {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role} ${isInterrupted ? 'interrupted' : ''}`;
    bubble.innerText = text;
    elements.transcriptMessages.appendChild(bubble);
    elements.transcriptMessages.scrollTop = elements.transcriptMessages.scrollHeight;
};

// Monitor FSM state changes for UI
const originalTransitionTo = transitionTo;
window.transitionTo = (newState) => {
    originalTransitionTo(newState);
    elements.stateBadge.innerText = newState;
    elements.stateBadge.className = `badge ${newState.toLowerCase()}`;
    
    if (newState === STATES.LISTENING) {
        elements.textInput.disabled = false;
        elements.textInput.placeholder = "Speak or type your answer...";
    } else if (newState === STATES.PROCESSING) {
        elements.textInput.disabled = true;
        elements.textInput.placeholder = "AI is thinking...";
    } else if (newState === STATES.AI_SPEAKING) {
        elements.textInput.disabled = false;
        elements.textInput.placeholder = "You can interrupt by speaking...";
    }
};

window.runTimer = (seconds) => {
    // Optional: Implement a countdown timer in the UI
};

// Basic Markdown Formatter (since we can't use a library without build step)
function formatMarkdown(text) {
    return text
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^\* (.*$)/gim, '<li>$1</li>')
        .replace(/^\- (.*$)/gim, '<li>$1</li>')
        .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
        .replace(/\*(.*)\*/gim, '<em>$1</em>')
        .replace(/\n/gim, '<br>');
}
